import { config } from "../config";
import { addDays, dateRange, fmtTime, localParts, nowSec, startOfLocalDay, weekday } from "../lib/time";
import type { Snapshot } from "../metrics/snapshot";
import { fmtH } from "../metrics/readiness";
import type { StoredRecommendation } from "../recs/claude";
import { esc, legend, ring, sleepWindows, sparkline, stackedBars, trendChart, type Series } from "./charts";
import { layout } from "./layout";

const toneVar = (tone: string | undefined) => `var(--${tone ?? "muted"})`;
const short = (d: string) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`;
const r0 = (x: number | null | undefined, unit = "") => (x == null ? "–" : `${Math.round(x)}${unit}`);
const r1 = (x: number | null | undefined, unit = "") => (x == null ? "–" : `${Math.round(x * 10) / 10}${unit}`);

function rolling(values: (number | null)[], n: number): (number | null)[] {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - n + 1), i + 1).filter((v): v is number => v != null);
    return w.length >= Math.min(3, n) ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

function delta(cur: number | null, base: number | null, unit: string, lowerIsBetter = false): string {
  if (cur == null || base == null) return "";
  const d = cur - base;
  const good = lowerIsBetter ? d < 0 : d > 0;
  const arrow = d === 0 ? "" : d > 0 ? "▲" : "▼";
  return `<em class="${Math.abs(d) < 0.05 * base ? "" : good ? "ok" : "bad"}">${arrow} ${Math.abs(Math.round(d * 10) / 10)}${unit}</em>`;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function recCard(rec: StoredRecommendation | null, today: string): string {
  if (!rec) {
    const p = localParts(nowSec());
    const before = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` < config.morningRunAt;
    return `<section class="card"><h2>Today's plan</h2>
      <p class="sub">${before ? `Generated after ${config.morningRunAt} once last night's sleep has synced.` : "Not generated yet. It runs automatically once sleep data arrives (latest " + config.morningRunLatest + ")."}</p>
      <form method="post" action="/actions/recommendations" class="inline"><button>Generate now</button></form></section>`;
  }
  const c = rec.content;
  const dayType: Record<string, string> = {
    train_hard: "Train hard", train_moderate: "Train moderate", train_light: "Train light", modified: "Modified session", rest: "Rest",
  };
  return `<section class="card">
    <h2>${esc(c.headline)}</h2>
    <p class="sub">${esc(dayType[c.day_type] ?? c.day_type)}${c.best_slot ? ` · ${esc(c.best_slot)}` : ""}</p>
    <ul class="recs">${c.recommendations
      .map((r) => `<li><span class="cat">${esc(r.category)}</span><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></li>`)
      .join("")}</ul>
    <p class="note" style="margin:10px 0 0"><span class="cat">Sleep</span><br>${esc(c.sleep_target)}</p>
    ${c.caution ? `<p class="warnline" style="margin-top:10px"><span class="dot" style="background:var(--warning)"></span>${esc(c.caution)}</p>` : ""}
    <div class="actions"><span class="muted" style="font-size:12px;align-self:center">${rec.date === today ? `Generated ${fmtTime(Math.floor(Date.parse(rec.created_at) / 1000))}` : esc(rec.date)}</span>
      <form method="post" action="/actions/recommendations" class="inline" style="margin-left:auto"><button>Regenerate</button></form></div>
  </section>`;
}

export function dashboardPage(s: Snapshot, rec: StoredRecommendation | null, opts: { googleConnected: boolean; flash?: string }): string {
  const R = s.readiness;
  const tone = toneVar(R.band?.tone);
  const today = s.days[s.days.length - 1];
  const last14 = s.days.slice(-14);
  const b = s.baselines;

  const hero = `<section class="card">
    <div class="hero">
      <div class="ringwrap">${ring(R.score, tone)}<div class="num"><b>${R.score ?? "–"}</b><span>readiness</span></div></div>
      <div>
        ${R.band ? `<span class="badge"><span class="dot" style="background:${tone}"></span>${esc(R.band.label)}</span>` : `<span class="badge">Not enough data yet</span>`}
        ${R.limiterText ? `<p class="limiter">Pulled down by <b>${esc(R.limiter!.label.toLowerCase())}</b>: ${esc(R.limiter!.detail)}</p>` : R.score != null ? `<p class="limiter">Nothing is holding you back today.</p>` : ""}
      </div>
    </div>
    <ul class="comps">${R.components
      .map((c) => `<li><span>${esc(c.label)}</span><span class="bar"><i style="width:${c.score ?? 0}%;${c.key === R.limiter?.key ? "background:var(--serious)" : ""}"></i></span><span class="val">${c.score ?? "–"}</span><span class="detail">${esc(c.detail)} · weight ${c.weight}</span></li>`)
      .join("")}</ul>
    <details><summary>Readiness, last 14 days</summary>
      ${stackedBars({
        bars: s.readinessHistory.map((h) => ({ label: weekday(h.date).slice(0, 2), tip: `${weekday(h.date)} ${short(h.date)}`, values: { score: h.score } })),
        series: [{ key: "score", label: "Readiness", color: "var(--s1)" }],
        max: 100, height: 120,
      })}
    </details>
  </section>`;

  // Sleep
  const sleepSeries: Series[] = [
    { key: "deep", label: "Deep", color: "var(--s1)" },
    { key: "core", label: "Core", color: "var(--s2)" },
    { key: "rem", label: "REM", color: "var(--s3)" },
    { key: "other", label: "Asleep (no stage)", color: "var(--s4)" },
  ];
  const sleepBars = last14.map((d) => {
    const staged = (d.deep_h ?? 0) + (d.core_h ?? 0) + (d.rem_h ?? 0);
    const other = d.sleep_h != null ? Math.max(0, d.sleep_h - staged) : null;
    return {
      label: weekday(d.date).slice(0, 2),
      tip: `${weekday(d.date)} ${short(d.date)} · ${d.sleep_h != null ? fmtH(d.sleep_h) : "no data"}${d.bed_ts && d.wake_ts ? ` (${fmtTime(d.bed_ts)}–${fmtTime(d.wake_ts)})` : ""}`,
      values: { deep: d.deep_h, core: d.core_h, rem: d.rem_h, other: other && other > 0.05 ? other : null },
    };
  });
  const usedSleepSeries = sleepSeries.filter((se) => sleepBars.some((bar) => (bar.values as Record<string, number | null>)[se.key]));
  const sc = s.sleepConsistency;
  const sleep = `<section class="card">
    <h2>Sleep</h2><p class="sub">Last night and the past 14 nights</p>
    <div class="kv">
      <div><small>Last night</small><b>${today.sleep_h != null ? fmtH(today.sleep_h) : "–"}</b> ${delta(today.sleep_h, b.sleep7, "h")}</div>
      <div><small>7-day avg</small><b>${b.sleep7 != null ? fmtH(b.sleep7) : "–"}</b></div>
      <div><small>Consistency</small><b>${sc.bedSdMin != null ? `±${Math.round(sc.bedSdMin)}m` : "–"}</b><em> bed</em><br><em>±${sc.wakeSdMin != null ? Math.round(sc.wakeSdMin) : "–"}m wake</em></div>
    </div>
    ${legend(usedSleepSeries.length ? usedSleepSeries : sleepSeries.slice(0, 3))}
    ${stackedBars({ bars: sleepBars, series: sleepSeries, refLine: { value: config.sleep.targetHours, label: `target ${fmtH(config.sleep.targetHours)}` }, fmt: (v) => fmtH(v) })}
    <details><summary>Bed and wake times</summary>
      ${sleepWindows(
        last14.slice(-10).map((d) => {
          const m = (ts: number | null) => {
            if (ts == null) return null;
            const p = localParts(ts);
            return ((p.hour - 12 + 24) % 24) * 60 + p.minute;
          };
          return { label: short(d.date), bedMin: m(d.bed_ts), wakeMin: m(d.wake_ts), tip: d.bed_ts && d.wake_ts ? `${short(d.date)}: ${fmtTime(d.bed_ts)} → ${fmtTime(d.wake_ts)}` : `${short(d.date)}: no data` };
        }),
        "var(--s1)",
      )}
    </details>
  </section>`;

  // Heart
  const hrvVals = s.days.map((d) => d.hrv);
  const rhrVals = s.days.map((d) => d.resting_hr);
  const heart = `<section class="card">
    <h2>Heart</h2><p class="sub">vs your own 7- and 28-day baselines</p>
    <div class="kv">
      <div><small>HRV (latest)</small><b>${r0(today.hrv ?? s.days[s.days.length - 2]?.hrv)}</b><em> ms</em></div>
      <div><small>HRV 7d / 28d</small><b>${r0(b.hrv7)}</b><em> / ${r0(b.hrv28)} ms</em></div>
      <div><small>Readings today</small><b>${today.hrv_n}</b></div>
    </div>
    <div class="legend"><span><i style="background:var(--s1);opacity:.6;border-radius:50%"></i>Daily</span><span><i class="line" style="background:var(--s1)"></i>7-day avg</span><span><i class="dash"></i>28-day baseline</span></div>
    ${trendChart({ points: s.days.map((d) => ({ label: short(d.date), value: d.hrv, tip: `${short(d.date)}: ${d.hrv == null ? "no data" : `${Math.round(d.hrv)} ms (${d.hrv_n} readings)`}` })), rolling: rolling(hrvVals, 7), baseline: b.hrv28, unit: "ms", color: "var(--s1)" })}
    <div class="kv" style="margin-top:14px">
      <div><small>Resting HR</small><b>${r0(today.resting_hr ?? s.days[s.days.length - 2]?.resting_hr)}</b><em> bpm</em></div>
      <div><small>RHR 7d / 28d</small><b>${r0(b.rhr7)}</b><em> / ${r0(b.rhr28)}</em></div>
      <div><small>vs baseline</small><b>${today.resting_hr != null && b.rhr28 != null ? `${today.resting_hr - b.rhr28 >= 0 ? "+" : "−"}${Math.abs(Math.round((today.resting_hr - b.rhr28) * 10) / 10)}` : "–"}</b></div>
    </div>
    ${trendChart({ points: s.days.map((d) => ({ label: short(d.date), value: d.resting_hr })), rolling: rolling(rhrVals, 7), baseline: b.rhr28, unit: "bpm", color: "var(--s1)" })}
  </section>`;

  // Tiles
  const tile = (label: string, value: string, unit: string, values: (number | null)[]) =>
    `<div class="tile"><small>${label}</small><b>${value}</b><em> ${unit}</em>${sparkline(values, "var(--s1)")}</div>`;
  const yesterday = s.days[s.days.length - 2];
  const tiles = `<div class="tiles">
    ${tile("SpO₂ overnight", r1(today.spo2), "%", last14.map((d) => d.spo2))}
    ${tile("Steps (yday)", yesterday?.steps != null ? Math.round(yesterday.steps).toLocaleString("en-US") : "–", "", last14.map((d) => d.steps))}
    ${tile("Active (yday)", r0(yesterday?.active_kcal), "kcal", last14.map((d) => d.active_kcal))}
  </div>`;

  // Training
  const loadSeries: Series[] = [
    { key: "tennis", label: "Tennis", color: "var(--s1)" },
    { key: "gym", label: "Gym", color: "var(--s2)" },
    { key: "other", label: "Other", color: "var(--s3)" },
  ];
  const [lo, hi] = config.training.acwrSweetSpot;
  const acwr = s.load.acwr;
  const acwrTone = acwr == null ? "muted" : acwr > 1.5 ? "critical" : acwr > hi ? "warning" : acwr < lo ? "warning" : "good";
  const acwrLabel = acwr == null ? "Building history" : acwr > 1.5 ? "Spike, back off" : acwr > hi ? "High" : acwr < lo ? "Below usual" : "In the sweet spot";
  const recent = s.sessions.filter((x) => x.date >= addDays(s.today, -6)).reverse();
  const training = `<section class="card">
    <h2>Training load</h2><p class="sub">Load = minutes × intensity (1–10)</p>
    <div class="kv">
      <div><small>Acute (7d)</small><b>${s.load.acute}</b></div>
      <div><small>Chronic (wk avg)</small><b>${Math.round(s.load.chronic)}</b></div>
      <div><small>Ratio</small><b>${acwr != null ? acwr.toFixed(2) : "–"}</b><br><em><span class="dot" style="background:${toneVar(acwrTone)}"></span> ${acwrLabel}</em></div>
    </div>
    ${legend(loadSeries)}
    ${stackedBars({
      bars: s.weekly.map((w) => ({ label: short(w.weekStart), tip: `Week of ${short(w.weekStart)} · ${w.sessions} sessions, ${Math.round(w.minutes / 6) / 10} h`, values: { tennis: w.tennis || null, gym: w.gym || null, other: w.other || null } })),
      series: loadSeries, unit: " AU", fmt: (v) => String(Math.round(v)),
    })}
    <ul class="events">${recent.length ? recent
      .map((x) => `<li><time>${weekday(x.date)} ${fmtTime(x.start_ts)}</time><span>${esc(x.name)} · ${Math.round(x.minutes)} min${x.planned ? "" : ` · ${x.load} AU`}</span><span class="tag">${x.planned ? "planned" : x.source === "calendar" ? "calendar" : x.avg_hr ? `${Math.round(x.avg_hr)} bpm` : "workout"}</span></li>`)
      .join("") : `<li class="muted">No sessions in the last 7 days</li>`}</ul>
  </section>`;

  // Calendar
  const week = dateRange(s.today, addDays(s.today, 6));
  const calendar = opts.googleConnected
    ? `<section class="card">
    <h2>Calendar load</h2><p class="sub">Booked hours (tennis excluded) · heavy = ${config.calendar.heavyDayHours}h+ or a full-day block</p>
    ${stackedBars({
      bars: s.busyness.map((d) => ({
        label: weekday(d.date).slice(0, 2),
        tip: `${weekday(d.date)} ${short(d.date)} · ${fmtH(d.hours)} booked${d.fullDay ? ", full-day block" : ""}${d.tennis ? `, ${d.tennis} tennis` : ""}`,
        values: { hours: d.hours || null },
        flag: d.heavy ? "!" : undefined,
        colorOverride: d.heavy ? "var(--warning)" : undefined,
      })),
      series: [{ key: "hours", label: "Booked", color: "var(--s1)" }],
      refLine: { value: config.calendar.heavyDayHours, label: "heavy" }, fmt: (v) => fmtH(v),
    })}
    ${s.busyness.some((d) => d.heavy) ? `<p class="warnline"><span class="dot" style="background:var(--warning)"></span>Heavy: ${s.busyness.filter((d) => d.heavy).map((d) => `${weekday(d.date)}${d.fullDay ? " (full day)" : ""}`).join(", ")}</p>` : ""}
    <details open><summary>Next 7 days</summary>
    <ul class="events">${week
      .flatMap((d) => {
        const ds = startOfLocalDay(d);
        return s.upcoming
          .filter((e) => e.start_ts < ds + 86400 && e.end_ts > ds && (e.start_date === d || d === s.today))
          .map((e) => `<li><time>${weekday(d)} ${e.all_day ? "all day" : fmtTime(e.start_ts)}</time><span>${esc(e.summary)}</span>${e.is_tennis ? `<span class="tag">tennis</span>` : e.busy ? "" : `<span class="tag">free</span>`}</li>`);
      })
      .join("") || `<li class="muted">Nothing booked</li>`}</ul></details>
  </section>`
    : `<section class="card"><h2>Calendar</h2><p class="sub">Not connected yet.</p><a class="btn" href="/auth/google/start">Connect Google Calendar</a></section>`;

  const table = `<details class="card"><summary>Data table (28 days)</summary><div class="tablewrap"><table>
    <tr><th>Date</th><th>Sleep</th><th>Deep</th><th>REM</th><th>RHR</th><th>HRV</th><th>SpO₂</th><th>Steps</th><th>kcal</th></tr>
    ${[...s.days].reverse().map((d) => `<tr><td>${weekday(d.date)} ${short(d.date)}</td><td>${d.sleep_h != null ? fmtH(d.sleep_h) : "–"}</td><td>${r1(d.deep_h)}</td><td>${r1(d.rem_h)}</td><td>${r0(d.resting_hr)}</td><td>${r0(d.hrv)}</td><td>${r1(d.spo2)}</td><td>${r0(d.steps)}</td><td>${r0(d.active_kcal)}</td></tr>`).join("")}
  </table></div></details>`;

  const f = s.freshness;
  const foot = `<p class="foot">Health data received ${ago(f.lastIngest)}${f.lastHealthSample ? ` · latest sample ${fmtTime(f.lastHealthSample)} ${short(localParts(f.lastHealthSample).date)}` : ""}<br>
    Calendar synced ${ago(f.lastCalendar)} · times in ${esc(config.timezone)}
    <form method="post" action="/actions/sync" class="inline"> · <button style="padding:2px 8px;font-size:12px">Sync now</button></form></p>`;

  const flash = opts.flash ? `<p class="card note">${esc(opts.flash)}</p>` : "";
  return layout(`${weekday(s.today)} ${short(s.today)}`, flash + hero + recCard(rec, s.today) + sleep + heart + tiles + training + calendar + table + foot);
}

export function historyPage(recs: StoredRecommendation[]): string {
  const items = recs.length
    ? recs
        .map(
          (r) => `<section class="card"><h2>${weekday(r.date)} ${esc(r.date)} · readiness ${r.readiness ?? "–"}</h2>
      <p class="sub">${esc(r.content.headline)}${r.content.best_slot ? ` · ${esc(r.content.best_slot)}` : ""}</p>
      <ul class="recs">${r.content.recommendations.map((x) => `<li><span class="cat">${esc(x.category)}</span><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></li>`).join("")}</ul>
      <p class="note" style="margin:8px 0 0">${esc(r.content.sleep_target)}</p></section>`,
        )
        .join("")
    : `<p class="empty">No recommendations yet.</p>`;
  return layout("History", items);
}

export function settingsPage(opts: {
  context: string;
  isDefault: boolean;
  googleConnected: boolean;
  origin: string;
  jobs: { kind: string; at: string; ok: number; message: string }[];
  payloads: { id: number; received_at: string; bytes: number; status: string; summary: string | null; error: string | null }[];
  saved?: boolean;
}): string {
  return layout(
    "Settings",
    `${opts.saved ? `<p class="card note ok">Saved.</p>` : ""}
    <section class="card"><h2>Training context</h2>
      <p class="sub">Sent to Claude with every morning run. Stored in your database only, never in git.${opts.isDefault ? " <b>Still the placeholder: replace it.</b>" : ""}</p>
      <form method="post" action="/settings/context"><textarea name="context">${esc(opts.context)}</textarea>
      <div class="actions"><button class="primary">Save</button></div></form></section>
    <section class="card"><h2>Connections</h2>
      <p>Google Calendar: ${opts.googleConnected ? `<span class="ok">connected</span>` : `<span class="bad">not connected</span>`} · <a class="btn" href="/auth/google/start">${opts.googleConnected ? "Reconnect" : "Connect"}</a></p>
      <p class="note">Health Auto Export endpoint:<br><code>${esc(opts.origin)}/api/ingest</code><br>Header: <code>Authorization: Bearer &lt;INGEST_TOKEN&gt;</code></p>
    </section>
    <section class="card"><h2>Recent health payloads</h2><div class="tablewrap"><table><tr><th>When</th><th>Size</th><th>Status</th><th>Contents</th></tr>
      ${opts.payloads.map((p) => `<tr><td>${esc(p.received_at.slice(5, 16).replace("T", " "))}Z</td><td>${Math.round(p.bytes / 1024)} KB</td><td class="${p.status === "parsed" ? "ok" : "bad"}">${esc(p.status)}</td><td style="text-align:left">${esc(p.error ?? summarise(p.summary))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Nothing received yet</td></tr>`}
    </table></div></section>
    <section class="card"><h2>Job log</h2><div class="tablewrap"><table><tr><th>When</th><th>Job</th><th style="text-align:left">Result</th></tr>
      ${opts.jobs.map((j) => `<tr><td>${esc(j.at.slice(5, 16).replace("T", " "))}Z</td><td class="${j.ok ? "ok" : "bad"}">${esc(j.kind)}</td><td style="text-align:left">${esc(j.message)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No jobs yet</td></tr>`}
    </table></div></section>
    <form method="post" action="/logout"><button>Log out</button></form>`,
  );
}

function summarise(json: string | null): string {
  if (!json) return "";
  try {
    const o = JSON.parse(json) as { counts?: Record<string, number>; skipped?: Record<string, number> };
    const counts = Object.entries(o.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
    const skipped = Object.entries(o.skipped ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
    return skipped ? `${counts} · skipped: ${skipped}` : counts;
  } catch {
    return "";
  }
}

export function loginPage(error?: string): string {
  return layout(
    "Health",
    `<section class="card" style="margin-top:20vh"><h2>Sign in</h2>
      ${error ? `<p class="bad note">${esc(error)}</p>` : ""}
      <form method="post" action="/login"><input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
      <div class="actions"><button class="primary">Sign in</button></div></form></section>`,
    { nav: false },
  );
}
