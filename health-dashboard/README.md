# Personal Health Dashboard

A private, single-user dashboard. Health data comes from Amazfit Helio Strap → Zepp → Apple Health → Health Auto Export. Calendar data comes from Google Calendar. On top of those it computes a daily readiness score, and every morning it asks Claude for 3–5 recommendations.

## Stack, and why

**Cloudflare Workers + D1 (SQLite) + Cron Triggers**, TypeScript, [Hono](https://hono.dev).

- **Cheap:** the free Workers plan covers day-to-day use (100k requests/day, 5 GB D1, cron included). The only running cost is the Claude API, roughly $2–3/month for one call a day.
  - The free plan caps CPU at 10 ms per request. Measured locally: parsing a 60-day payload with hourly heart rate takes about 3 ms, recomputing 60 days about 3 ms, and the dashboard math about 1.5 ms. Hourly pushes are well inside the cap, but a big one-off backfill is close to it.
  - Backfill in 2-week chunks (see step 3), or switch to Workers Paid ($5/month, 30 s CPU) if you ever see "Exceeded CPU" errors in the Cloudflare dashboard.
- **Low maintenance:** one deployable unit with no separate database service, no containers and nothing to patch. Server-rendered HTML with inline SVG charts, so there's no frontend build step.
- **Cron that fits:** one trigger every 30 min (calendar sync, recompute, morning run). Vercel's free tier only allows daily crons.
- **Private by default:** HTTPS only (HSTS), strict CSP, `noindex`, no third-party scripts or analytics. Cloudflare's own request logs are the only telemetry.

## How it works

```
Health Auto Export ──POST /api/ingest (Bearer token)──▶ raw_payloads (gzip, sha256-deduped)
                                                          │ parse (tolerant of HAE v1/v2)
                                                          ▼
                    samples · sleep_summaries · sleep_segments · workouts   (natural-key upserts)
                                                          │ recompute touched dates
                                                          ▼
Google Calendar ──every ~hour──▶ calendar_events    daily_metrics
                                         │                │
                                         └──── snapshot: baselines, load, busyness, readiness
                                                          │
                       06:30 Bali (or when last night's sleep arrives, latest 10:00)
                                                          ▼
                                       Claude ──▶ recommendations (history kept)
```

- **Idempotent ingest.** A byte-identical re-send is skipped by hash. Overlapping data upserts on `(metric, timestamp, source)`, `(night, source)` and workout id, so nothing is ever double counted. Steps and energy are summed per source, then the biggest source wins, so iPhone and strap don't add up.
- **Timezones.** Everything is bucketed in `Asia/Makassar`. Google returns each timed event with an explicit UTC offset. We use the offset and ignore the label, so the Europe/Zurich calendar default and the Europe/Paris-labelled events land on the right Bali time. All-day events are Bali dates.
- **Sleep** is attributed to the morning you wake up. Naps more than 2 h away from the main sleep don't move your bedtime.
- **Tennis.** An event counts as tennis if its title, location or description matches `Court N`, `Liga.Tennis`, `tennis` or `padel` (configurable). Tennis is excluded from busyness and counted as training. If a booking overlaps a tennis workout from Apple Health, it's counted once, using the workout's heart rate. A past booking without a workout is counted at the default intensity. Future bookings are shown as planned and never add load.

## Readiness score

All knobs live in [`src/config.ts`](src/config.ts) (`readiness` section). The formula is in [`src/metrics/readiness.ts`](src/metrics/readiness.ts).

```
score = Σ(weight × component) / Σ(weight)    over components that have data
```

Each component maps one measurement onto 0–100 with a straight line between a "bad" anchor (0) and a "good" anchor (100), clamped:

| Component | Weight | Measurement | 0 at | 100 at |
|---|---|---|---|---|
| HRV | 30 | last night's HRV ÷ 28-day baseline | 0.80 | 1.05 |
| Resting HR | 20 | resting HR − 28-day baseline | +6 bpm | −2 bpm |
| Sleep | 25 | ½ × (last night ÷ 28-day avg) + ½ × hours | 0.70 / 5 h | 1.05 / 7.5 h |
| Training load | 15 | acute (7-day) ÷ chronic (28-day weekly avg) | 2.0 | 0.8–1.3 (70 at 0.4) |
| Calendar | 10 | today's busy h + ½ × tomorrow's (+6 if full-day block) | 10 h | 3 h |

- Baselines need 5+ days of data. Until then a component shows "Building baseline" and is skipped, and the other weights are re-normalised. ACWR needs about 3 weeks of history.
- If HRV or resting HR hasn't arrived yet at 06:30, yesterday's value is used.
- **Limiter** ("pulled down by …") is the component costing the most points, i.e. `weight × (100 − score)`. It's only shown when that component scores below 80.
- Session load = minutes × intensity (1–10). Intensity = 10 × heart-rate reserve when the workout has an average HR, otherwise a default per activity type.

## Setup checklist

You need: a Cloudflare account (free), a Google account, an Anthropic API key, and Node 20+ on a computer.

### 1. Deploy to Cloudflare (≈10 min)

```bash
cd health-dashboard
npm install
npx wrangler login                    # opens the browser
npx wrangler d1 create health         # copy the database_id it prints…
#  …into wrangler.toml → [[d1_databases]] database_id
npm run db:migrate:remote

# Secrets (each command prompts for the value):
openssl rand -base64 32               # run 2× to make INGEST_TOKEN and SESSION_SECRET
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DASHBOARD_PASSWORD     # long passphrase, you'll type it on your phone once
npx wrangler secret put ANTHROPIC_API_KEY      # console.anthropic.com → API keys

npm run deploy                        # prints https://health-dashboard.<you>.workers.dev
```

Open the URL on your iPhone, sign in, then Share → **Add to Home Screen**. You stay signed in for 30 days.

### 2. Google Calendar (read-only) (≈10 min)

1. Go to <https://console.cloud.google.com> and create a project (e.g. "health-dashboard").
2. **APIs & Services → Library**: enable **Google Calendar API**.
3. **OAuth consent screen** (Google Auth Platform → Branding / Audience): user type **External**, app name of your choice, your email.
   - Under **Data access**, add the scope `.../auth/calendar.readonly`.
   - Under **Audience**, click **Publish app** (status "In production"). Leaving it in "Testing" makes Google expire the refresh token after 7 days. An unverified app is fine for personal use: you'll see "Google hasn't verified this app", then **Advanced → Go to … (unsafe)**.
4. **Clients → Create client → Web application**.
   - Authorized redirect URI: `https://health-dashboard.<you>.workers.dev/auth/google/callback`
5. Store the credentials (no redeploy needed):
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
6. On the dashboard, open **Settings → Connect**, approve, and check that the flash message lists your events and tennis bookings.

### 3. Health Auto Export (iPhone) (≈10 min)

The app needs the paid tier for REST API automations. In **Automations → +**:

**Automation A: "Dashboard metrics"**

- Type: **REST API**
- URL: `https://health-dashboard.<you>.workers.dev/api/ingest`
- Headers: `Authorization` = `Bearer <your INGEST_TOKEN>`
- Data type: **Health Metrics**. Select: Heart Rate, Resting Heart Rate, Heart Rate Variability, Blood Oxygen Saturation, Step Count, Active Energy, Sleep Analysis (Respiratory Rate is optional)
- Export format **JSON**, export version **2**
- Summarize data: **on**. Time grouping: **hours**. This keeps heart-rate payloads small. Sleep stays one row per night.
- Date range: last few days. Re-sending overlapping data is safe.
- Sync cadence: **hourly**

**Automation B: "Dashboard workouts"**

- Same URL and header
- Data type: **Workouts**
- Leave route/GPS data off. Heart-rate summary data is useful.
- Sync cadence: hourly

Then:

- **Backfill once** so the 28-day baselines exist from day one: use Manual Export → REST API to send the last **60 days**, in four 2-week chunks. That keeps each request well inside the free plan's CPU limit. Overlapping ranges are harmless.
- **Check it landed:** **Settings → Recent health payloads** should show `parsed` with counts per metric. Errors appear there and in the job log. If a metric shows up under "skipped", its name differs from what the parser expects (see `METRIC_ALIASES` in `src/ingest/parse.ts`).
- **Reliability:** iOS throttles background apps. To make sure last night's sleep arrives before 06:30, add a Shortcuts **personal automation** at **06:00** that runs Health Auto Export's "Dashboard metrics" automation. If sleep is late, the morning run waits and retries every 30 min until 10:00, then runs anyway.

### 4. Training context

Open **Settings → Training context** and paste your notes (injuries, weekly routine, preferences). It's stored in D1 only, never in git, and goes into every morning prompt.

### 5. Optional extra hardening

- **Cloudflare Access** (free for 1 user): put the hostname behind email one-time-PIN login, with a **Bypass** policy for `/api/ingest` (the bearer token still protects it).
- **Custom domain:** Workers → your worker → Settings → Domains & Routes.

## Tweaking

| Want to change… | Where |
|---|---|
| Readiness weights and anchors, score bands | `src/config.ts` → `readiness` |
| Sleep target, ACWR sweet spot, max HR, default intensities | `src/config.ts` → `sleep`, `training` |
| Tennis detection, heavy-day threshold, extra calendars | `src/config.ts` → `calendar` |
| Morning run time / latest retry time | `src/config.ts` → `morningRunAt`, `morningRunLatest` |
| Claude model | `wrangler.toml` → `CLAUDE_MODEL` |
| Prompt wording | `src/recs/claude.ts` → `SYSTEM` |

Then `npm run deploy`. Readiness history is recomputed with the current formula on every page load, so changes apply retroactively.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                                   # http://localhost:8787, password "dev-password"
node scripts/demo-payload.mjs 40 > /tmp/demo.json
curl -X POST localhost:8787/api/ingest -H "Authorization: Bearer dev-ingest-token" --data-binary @/tmp/demo.json
npm test && npm run typecheck
```

## Data and privacy

- Stored in your own Cloudflare D1 database: raw payloads (compressed), parsed samples, calendar event titles and times, and recommendations.
- Sent to the Anthropic API once a day: the 14-day metrics summary, upcoming calendar titles and times, and your training context. Nothing else leaves Cloudflare.
- To delete everything: `npx wrangler d1 delete health`.
