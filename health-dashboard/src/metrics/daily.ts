import type { Env } from "../env";
import type { SleepSegment, SleepSummary } from "../ingest/parse";
import { addDays, localParts } from "../lib/time";

export interface DailyRow {
  date: string;
  sleep_h: number | null;
  in_bed_h: number | null;
  deep_h: number | null;
  core_h: number | null;
  rem_h: number | null;
  awake_h: number | null;
  bed_ts: number | null;
  wake_ts: number | null;
  resting_hr: number | null;
  hrv: number | null;
  hrv_n: number;
  spo2: number | null;
  spo2_min: number | null;
  steps: number | null;
  active_kcal: number | null;
}

interface SampleRow {
  metric: string;
  ts: number;
  local_date: string;
  source: string;
  value: number;
}

export interface NightSleep {
  asleep_h: number;
  in_bed_h: number | null;
  deep_h: number | null;
  core_h: number | null;
  rem_h: number | null;
  awake_h: number | null;
  bed_ts: number | null;
  wake_ts: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Pick the main night from summarised rows: the source with the most sleep. */
export function nightFromSummaries(rows: SleepSummary[]): NightSleep | null {
  const best = rows.filter((r) => (r.asleep_h ?? 0) > 0).sort((a, b) => (b.asleep_h ?? 0) - (a.asleep_h ?? 0))[0];
  if (!best) return null;
  return {
    asleep_h: best.asleep_h!,
    in_bed_h: best.in_bed_h,
    deep_h: best.deep_h,
    core_h: best.core_h,
    rem_h: best.rem_h,
    awake_h: best.awake_h,
    bed_ts: best.sleep_start_ts ?? best.in_bed_start_ts,
    wake_ts: best.sleep_end_ts ?? best.in_bed_end_ts,
  };
}

/**
 * Build a night from stage segments. Segments are split into clusters at gaps
 * over 2 h (so a nap doesn't drag the bedtime around); the cluster with the most
 * sleep is the main night. Per source, then the source with the most sleep wins.
 */
export function nightFromSegments(segs: Pick<SleepSegment, "start_ts" | "end_ts" | "stage" | "source">[]): NightSleep | null {
  const bySource = new Map<string, typeof segs>();
  for (const s of segs) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
  let best: NightSleep | null = null;
  for (const list of bySource.values()) {
    const sorted = [...list].sort((a, b) => a.start_ts - b.start_ts);
    const clusters: (typeof segs)[] = [];
    let cur: typeof segs = [];
    let curEnd = -Infinity;
    for (const s of sorted) {
      if (cur.length && s.start_ts - curEnd > 2 * 3600) {
        clusters.push(cur);
        cur = [];
      }
      cur.push(s);
      curEnd = Math.max(curEnd, s.end_ts);
    }
    if (cur.length) clusters.push(cur);
    for (const c of clusters) {
      const h = (stage: string) => c.filter((s) => s.stage === stage).reduce((t, s) => t + (s.end_ts - s.start_ts) / 3600, 0);
      const deep = h("deep"), core = h("core"), rem = h("rem"), generic = h("asleep"), awake = h("awake");
      const asleep = deep + core + rem + generic;
      if (asleep <= 0) continue;
      const sleepSegs = c.filter((s) => s.stage !== "awake" && s.stage !== "inbed");
      const bed = Math.min(...sleepSegs.map((s) => s.start_ts));
      const wake = Math.max(...sleepSegs.map((s) => s.end_ts));
      const inBedSegs = c.filter((s) => s.stage === "inbed");
      const inBed = inBedSegs.length
        ? (Math.max(...inBedSegs.map((s) => s.end_ts), wake) - Math.min(...inBedSegs.map((s) => s.start_ts), bed)) / 3600
        : (wake - bed) / 3600;
      const hasStages = deep + core + rem > 0;
      const night: NightSleep = {
        asleep_h: asleep,
        in_bed_h: inBed,
        deep_h: hasStages ? deep : null,
        core_h: hasStages ? core : null,
        rem_h: hasStages ? rem : null,
        awake_h: awake || null,
        bed_ts: bed,
        wake_ts: wake,
      };
      if (!best || night.asleep_h > best.asleep_h) best = night;
    }
  }
  return best;
}

/** Additive metrics: sum per source, then take the largest source (avoids iPhone + watch double counting). */
export function additiveTotal(rows: { source: string; value: number }[]): number | null {
  if (!rows.length) return null;
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.source, (per.get(r.source) ?? 0) + r.value);
  return Math.max(...per.values());
}

export function computeDay(
  date: string,
  samples: SampleRow[],
  summaries: SleepSummary[],
  segments: SleepSegment[],
): DailyRow {
  const ofDay = (metric: string) => samples.filter((s) => s.metric === metric && s.local_date === date);
  const night = nightFromSummaries(summaries.filter((s) => s.night_date === date)) ?? nightFromSegments(segments.filter((s) => s.night_date === date));

  // Overnight SpO2: inside the sleep window if we know it, else 00:00–08:00 local.
  const spo2All = samples.filter((s) => s.metric === "spo2");
  let spo2 = night?.bed_ts && night?.wake_ts
    ? spo2All.filter((s) => s.ts >= night.bed_ts! && s.ts <= night.wake_ts!)
    : [];
  if (!spo2.length) spo2 = spo2All.filter((s) => s.local_date === date && localParts(s.ts).hour < 8);
  const spo2Vals = spo2.map((s) => s.value);

  const hrv = ofDay("hrv").map((s) => s.value);
  const rhr = ofDay("resting_hr").map((s) => s.value);

  return {
    date,
    sleep_h: night?.asleep_h ?? null,
    in_bed_h: night?.in_bed_h ?? null,
    deep_h: night?.deep_h ?? null,
    core_h: night?.core_h ?? null,
    rem_h: night?.rem_h ?? null,
    awake_h: night?.awake_h ?? null,
    bed_ts: night?.bed_ts ?? null,
    wake_ts: night?.wake_ts ?? null,
    resting_hr: mean(rhr),
    hrv: mean(hrv),
    hrv_n: hrv.length,
    spo2: mean(spo2Vals),
    spo2_min: spo2Vals.length ? Math.min(...spo2Vals) : null,
    steps: additiveTotal(ofDay("steps")),
    active_kcal: additiveTotal(ofDay("active_kcal")),
  };
}

/** Recompute and upsert daily_metrics for the given dates. */
export async function recomputeDays(env: Env, dates: Iterable<string>) {
  const list = [...new Set(dates)].sort();
  if (!list.length) return;
  const from = list[0];
  const to = list[list.length - 1];
  const db = env.DB;
  const [samples, summaries, segments] = await Promise.all([
    db.prepare(
      "SELECT metric, ts, local_date, source, value FROM samples WHERE local_date BETWEEN ? AND ? AND metric IN ('hrv','resting_hr','spo2','steps','active_kcal')",
    ).bind(addDays(from, -1), to).all<SampleRow>(),
    db.prepare("SELECT * FROM sleep_summaries WHERE night_date BETWEEN ? AND ?").bind(from, to).all<SleepSummary>(),
    db.prepare("SELECT * FROM sleep_segments WHERE night_date BETWEEN ? AND ?").bind(from, to).all<SleepSegment>(),
  ]);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO daily_metrics (date, sleep_h, in_bed_h, deep_h, core_h, rem_h, awake_h, bed_ts, wake_ts,
       resting_hr, hrv, hrv_n, spo2, spo2_min, steps, active_kcal, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (date) DO UPDATE SET
       sleep_h = excluded.sleep_h, in_bed_h = excluded.in_bed_h, deep_h = excluded.deep_h, core_h = excluded.core_h,
       rem_h = excluded.rem_h, awake_h = excluded.awake_h, bed_ts = excluded.bed_ts, wake_ts = excluded.wake_ts,
       resting_hr = excluded.resting_hr, hrv = excluded.hrv, hrv_n = excluded.hrv_n, spo2 = excluded.spo2,
       spo2_min = excluded.spo2_min, steps = excluded.steps, active_kcal = excluded.active_kcal,
       updated_at = excluded.updated_at`,
  );
  // Index once so each day only scans its own samples (plus the previous day for overnight SpO2).
  const byDate = new Map<string, SampleRow[]>();
  for (const s of samples.results) {
    const list = byDate.get(s.local_date);
    if (list) list.push(s);
    else byDate.set(s.local_date, [s]);
  }
  const stmts = list.map((d) => {
    const near = [...(byDate.get(addDays(d, -1)) ?? []), ...(byDate.get(d) ?? [])];
    const r = computeDay(d, near, summaries.results, segments.results);
    return stmt.bind(
      r.date, r.sleep_h, r.in_bed_h, r.deep_h, r.core_h, r.rem_h, r.awake_h, r.bed_ts, r.wake_ts,
      r.resting_hr, r.hrv, r.hrv_n, r.spo2, r.spo2_min, r.steps, r.active_kcal, now,
    );
  });
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}
