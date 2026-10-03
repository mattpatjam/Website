import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config";
import type { Env } from "../env";
import { getSetting, logJob } from "../env";
import { addDays, dateRange, fmtTime, localTimeOn, startOfLocalDay, weekday } from "../lib/time";
import type { Snapshot } from "../metrics/snapshot";
import { DEFAULT_TRAINING_CONTEXT } from "./context";

export const RecommendationSchema = z.object({
  headline: z.string().describe("One sentence summary of the day, max ~15 words."),
  day_type: z.enum(["train_hard", "train_moderate", "train_light", "modified", "rest"]),
  best_slot: z.string().describe("Best time window today for tennis or gym, in local time, e.g. '16:30–18:00 (tennis)'. Empty string if rest day."),
  sleep_target: z.string().describe("Tonight's sleep target, e.g. 'Lights out 22:30, aim for 7h45'."),
  recommendations: z
    .array(
      z.object({
        category: z.enum(["training", "timing", "sleep", "recovery", "injury", "nutrition", "other"]),
        title: z.string().describe("Short imperative, max ~8 words."),
        detail: z.string().describe("One or two specific sentences."),
      }),
    )
    .describe("3 to 5 items, most important first."),
  caution: z.string().describe("Anything that warrants checking with the physio/doctor; empty string if none."),
});
export type RecommendationContent = z.infer<typeof RecommendationSchema>;

const SYSTEM = `You are a sports-science-literate coach reviewing one athlete's wearable and calendar data each morning.
Write 3–5 short, specific recommendations for today.

How to reason:
- Readiness is a 0–100 score computed by the dashboard; its components and the limiting factor are given. Trust the trends over a single reading, and say so when data is missing or stale.
- HRV is Apple Health SDNN from an Amazfit Helio Strap with only a few readings per day, so it is noisy; weigh it alongside resting HR and sleep rather than on its own.
- Training load is session-RPE style (minutes × intensity). ACWR 0.8–1.3 is the sweet spot; above 1.5 means back off.
- Respect the athlete's injuries and preferences in the training context. They prefer modified activity over full rest: when recovery is poor, suggest a modified session (e.g. skip serves/overheads, baseline rallies only, mobility, lower-body-light strength) rather than "rest" unless the data is clearly bad.
- Use the calendar: pick a concrete time window for tennis or gym that fits the free slots and avoids squeezing it before a heavy block. All times are local (${config.timezone}). Bali is hot and humid; midday outdoor court sessions are harder than early morning or late afternoon.
- Be concrete (times, durations, numbers). No generic wellness advice, no disclaimers, no medical diagnosis. If something looks like it needs a professional, put it in "caution".`;

function freeSlots(s: Snapshot, date: string): string[] {
  const dayStart = localTimeOn(date, "06:00");
  const dayEnd = localTimeOn(date, "21:00");
  const busy = s.upcoming
    .filter((e) => !e.all_day && e.busy && e.start_ts < dayEnd && e.end_ts > dayStart)
    .map((e) => [Math.max(e.start_ts, dayStart), Math.min(e.end_ts, dayEnd)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: string[] = [];
  let cursor = dayStart;
  for (const [a, b] of busy) {
    if (a - cursor >= 3600) out.push(`${fmtTime(cursor)}–${fmtTime(a)}`);
    cursor = Math.max(cursor, b);
  }
  if (dayEnd - cursor >= 3600) out.push(`${fmtTime(cursor)}–${fmtTime(dayEnd)}`);
  return out;
}

const r1 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 10) / 10);

export function buildPromptData(s: Snapshot, trainingContext: string) {
  const last14 = s.days.slice(-14);
  const sessionsByDate = (d: string) =>
    s.sessions.filter((x) => x.date === d).map((x) => `${x.name} ${Math.round(x.minutes)}min${x.planned ? " (planned)" : ` load ${x.load}`}${x.source === "calendar" ? " [calendar]" : ""}`);
  return {
    today: `${weekday(s.today)} ${s.today}`,
    training_context: trainingContext,
    sleep_target_hours: config.sleep.targetHours,
    readiness: {
      score: s.readiness.score,
      band: s.readiness.band?.label ?? null,
      limiting_factor: s.readiness.limiterText,
      components: s.readiness.components.map((c) => ({ factor: c.label, score: c.score, weight: c.weight, detail: c.detail })),
      last_14_days: s.readinessHistory.map((h) => h.score),
    },
    baselines: {
      hrv_ms: { avg7: r1(s.baselines.hrv7), avg28: r1(s.baselines.hrv28) },
      resting_hr_bpm: { avg7: r1(s.baselines.rhr7), avg28: r1(s.baselines.rhr28) },
      sleep_h: { avg7: r1(s.baselines.sleep7), avg28: r1(s.baselines.sleep28) },
      sleep_consistency_sd_min: { bedtime: r1(s.sleepConsistency.bedSdMin), wake: r1(s.sleepConsistency.wakeSdMin) },
    },
    training_load: {
      acute_7d: s.load.acute,
      chronic_weekly_avg_28d: Math.round(s.load.chronic),
      acwr: r1(s.load.acwr),
    },
    daily_last_14: last14.map((d) => ({
      date: `${weekday(d.date)} ${d.date}`,
      sleep_h: r1(d.sleep_h),
      deep_h: r1(d.deep_h),
      rem_h: r1(d.rem_h),
      bed: d.bed_ts ? fmtTime(d.bed_ts) : null,
      wake: d.wake_ts ? fmtTime(d.wake_ts) : null,
      resting_hr: r1(d.resting_hr),
      hrv_ms: r1(d.hrv),
      hrv_readings: d.hrv_n,
      spo2_night: r1(d.spo2),
      steps: d.steps == null ? null : Math.round(d.steps),
      active_kcal: d.active_kcal == null ? null : Math.round(d.active_kcal),
      sessions: sessionsByDate(d.date),
    })),
    calendar_next_7_days: dateRange(s.today, addDays(s.today, 6)).map((d) => {
      const load = s.busyness.find((b) => b.date === d);
      const dayStart = startOfLocalDay(d);
      return {
        date: `${weekday(d)} ${d}`,
        booked_hours: r1(load?.hours ?? 0),
        heavy: load?.heavy ?? false,
        events: s.upcoming
          .filter((e) => e.start_ts < dayStart + 86400 && e.end_ts > dayStart)
          .map((e) => (e.all_day ? `all day: ${e.summary}` : `${fmtTime(e.start_ts)}–${fmtTime(e.end_ts)} ${e.summary}${e.is_tennis ? " [TENNIS]" : ""}${e.busy ? "" : " (free)"}`)),
      };
    }),
    free_slots: { today: freeSlots(s, s.today), tomorrow: freeSlots(s, addDays(s.today, 1)) },
  };
}

export async function generateRecommendations(env: Env, s: Snapshot): Promise<RecommendationContent> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const context = (await getSetting(env, "training_context")) ?? DEFAULT_TRAINING_CONTEXT;
  const data = buildPromptData(s, context);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.beta.messages.parse({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(RecommendationSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: `Today's data (JSON):\n${JSON.stringify(data)}` }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to answer this request");
  if (response.stop_reason === "max_tokens") throw new Error("Claude response was cut off (max_tokens)");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude response did not match the schema");
  parsed.recommendations = parsed.recommendations.slice(0, 5);

  await env.DB.prepare("INSERT INTO recommendations (date, created_at, model, readiness, content) VALUES (?, ?, ?, ?, ?)")
    .bind(s.today, new Date().toISOString(), response.model, s.readiness.score, JSON.stringify(parsed))
    .run();
  await logJob(env, "recs", true, `Generated for ${s.today} (readiness ${s.readiness.score ?? "n/a"})`);
  return parsed;
}

export interface StoredRecommendation {
  id: number;
  date: string;
  created_at: string;
  model: string;
  readiness: number | null;
  content: RecommendationContent;
}

export async function latestRecommendation(env: Env, date: string): Promise<StoredRecommendation | null> {
  const row = await env.DB.prepare("SELECT * FROM recommendations WHERE date = ? ORDER BY id DESC LIMIT 1").bind(date).first<StoredRecommendation & { content: string }>();
  return row ? { ...row, content: JSON.parse(row.content as unknown as string) } : null;
}

export async function recommendationHistory(env: Env, limit = 30): Promise<StoredRecommendation[]> {
  // Latest generation per day.
  const res = await env.DB.prepare(
    "SELECT r.* FROM recommendations r JOIN (SELECT date, MAX(id) AS id FROM recommendations GROUP BY date) m ON r.id = m.id ORDER BY r.date DESC LIMIT ?",
  ).bind(limit).all<StoredRecommendation & { content: string }>();
  return res.results.map((r) => ({ ...r, content: JSON.parse(r.content as unknown as string) }));
}
