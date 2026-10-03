/**
 * Health Auto Export (HAE) → normalised records. Pure functions, no I/O.
 *
 * HAE REST automation body (JSON, v2 format):
 *   { "data": { "metrics": [ { "name", "units", "data": [ ... ] } ],
 *               "workouts": [ { "id", "name", "start", "end", ... } ] } }
 *
 * We are deliberately tolerant: older/newer HAE versions rename fields, so every
 * lookup has fallbacks and anything unrecognised is counted and skipped.
 */
import { localDate, nightDateFor, parseHaeDate } from "../lib/time";

export interface Sample {
  metric: string;
  ts: number;
  local_date: string;
  source: string;
  value: number;
  value_min: number | null;
  value_max: number | null;
}

export interface SleepSummary {
  night_date: string;
  source: string;
  sleep_start_ts: number | null;
  sleep_end_ts: number | null;
  in_bed_start_ts: number | null;
  in_bed_end_ts: number | null;
  asleep_h: number | null;
  in_bed_h: number | null;
  deep_h: number | null;
  core_h: number | null;
  rem_h: number | null;
  awake_h: number | null;
}

export interface SleepSegment {
  start_ts: number;
  end_ts: number;
  stage: "deep" | "core" | "rem" | "awake" | "asleep" | "inbed";
  source: string;
  night_date: string;
}

export interface Workout {
  id: string;
  name: string;
  start_ts: number;
  end_ts: number;
  local_date: string;
  duration_min: number;
  active_kcal: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  distance_km: number | null;
  source: string;
}

export interface ParsedPayload {
  samples: Sample[];
  sleepSummaries: SleepSummary[];
  sleepSegments: SleepSegment[];
  workouts: Workout[];
  counts: Record<string, number>;
  skipped: Record<string, number>;
}

/** HAE metric name → our metric key. */
const METRIC_ALIASES: Record<string, string> = {
  resting_heart_rate: "resting_hr",
  heart_rate_variability: "hrv",
  heart_rate_variability_sdnn: "hrv",
  blood_oxygen_saturation: "spo2",
  oxygen_saturation: "spo2",
  step_count: "steps",
  steps: "steps",
  active_energy: "active_kcal",
  active_energy_burned: "active_kcal",
  heart_rate: "heart_rate",
  respiratory_rate: "respiratory_rate",
  sleep_analysis: "sleep",
};

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === "object" && "qty" in v) return num((v as { qty: unknown }).qty);
  return null;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const toKcal = (qty: number, units: string) => (/kj/i.test(units) ? qty / 4.184 : qty);

function normaliseValue(metric: string, value: number, units: string): number {
  if (metric === "active_kcal") return toKcal(value, units);
  if (metric === "spo2") return value <= 1 ? value * 100 : value;
  return value;
}

export function parseHaePayload(body: unknown): ParsedPayload {
  const out: ParsedPayload = {
    samples: [],
    sleepSummaries: [],
    sleepSegments: [],
    workouts: [],
    counts: {},
    skipped: {},
  };
  const bump = (bag: Record<string, number>, k: string, n = 1) => (bag[k] = (bag[k] ?? 0) + n);

  const root = (body as { data?: unknown })?.data ?? body;
  const metrics = Array.isArray((root as { metrics?: unknown })?.metrics)
    ? ((root as { metrics: unknown[] }).metrics as Record<string, unknown>[])
    : [];
  const workouts = Array.isArray((root as { workouts?: unknown })?.workouts)
    ? ((root as { workouts: unknown[] }).workouts as Record<string, unknown>[])
    : [];

  for (const m of metrics) {
    const haeName = str(m.name).toLowerCase();
    const key = METRIC_ALIASES[haeName];
    const units = str(m.units);
    const rows = Array.isArray(m.data) ? (m.data as Record<string, unknown>[]) : [];
    if (!key) {
      bump(out.skipped, haeName || "(unnamed)", rows.length);
      continue;
    }
    if (key === "sleep") {
      for (const r of rows) parseSleepRow(r, out, bump);
      continue;
    }
    for (const r of rows) {
      const ts = parseHaeDate(r.date ?? r.startDate);
      const source = str(r.source);
      if (ts == null) {
        bump(out.skipped, `${key}:bad_date`);
        continue;
      }
      let value = num(r.qty);
      let vmin: number | null = null;
      let vmax: number | null = null;
      if (key === "heart_rate") {
        value = num(r.Avg ?? r.avg) ?? value;
        vmin = num(r.Min ?? r.min);
        vmax = num(r.Max ?? r.max);
      }
      if (value == null) {
        bump(out.skipped, `${key}:no_value`);
        continue;
      }
      out.samples.push({
        metric: key,
        ts,
        local_date: localDate(ts),
        source,
        value: normaliseValue(key, value, units),
        value_min: vmin,
        value_max: vmax,
      });
      bump(out.counts, key);
    }
  }

  for (const w of workouts) {
    const parsed = parseWorkout(w);
    if (parsed) {
      out.workouts.push(parsed);
      bump(out.counts, "workouts");
    } else {
      bump(out.skipped, "workouts:invalid");
    }
  }
  return out;
}

const STAGES: Record<string, SleepSegment["stage"]> = {
  deep: "deep",
  core: "core",
  light: "core",
  rem: "rem",
  awake: "awake",
  asleep: "asleep",
  unspecified: "asleep",
  "in bed": "inbed",
  inbed: "inbed",
};

function parseSleepRow(
  r: Record<string, unknown>,
  out: ParsedPayload,
  bump: (bag: Record<string, number>, k: string, n?: number) => void,
) {
  const source = str(r.source);
  // Unsummarised: one stage segment per row.
  if (typeof r.value === "string" && (r.startDate || r.start)) {
    const start = parseHaeDate(r.startDate ?? r.start);
    const end = parseHaeDate(r.endDate ?? r.end);
    const stage = STAGES[r.value.toLowerCase().replace(/^asleep/, "").trim() || "asleep"] ?? STAGES[r.value.toLowerCase()];
    if (start == null || end == null || end <= start || !stage) {
      bump(out.skipped, "sleep:bad_segment");
      return;
    }
    out.sleepSegments.push({ start_ts: start, end_ts: end, stage, source, night_date: nightDateFor(end) });
    bump(out.counts, "sleep_segments");
    return;
  }

  // Summarised: one row per night with hours per stage.
  const sleepStart = parseHaeDate(r.sleepStart);
  const sleepEnd = parseHaeDate(r.sleepEnd);
  const inBedStart = parseHaeDate(r.inBedStart);
  const inBedEnd = parseHaeDate(r.inBedEnd);
  const anchor = sleepEnd ?? inBedEnd ?? parseHaeDate(r.date);
  if (anchor == null) {
    bump(out.skipped, "sleep:bad_date");
    return;
  }
  const deep = num(r.deep);
  const core = num(r.core);
  const rem = num(r.rem);
  const stagesSum = (deep ?? 0) + (core ?? 0) + (rem ?? 0);
  // Zepp sometimes reports totalSleep 0 with stages filled (or only "asleep").
  const asleep = [num(r.totalSleep), num(r.asleep), stagesSum].find((v) => v != null && v > 0) ?? null;
  out.sleepSummaries.push({
    night_date: sleepEnd != null || inBedEnd != null ? nightDateFor(anchor) : localDate(anchor),
    source,
    sleep_start_ts: sleepStart,
    sleep_end_ts: sleepEnd,
    in_bed_start_ts: inBedStart,
    in_bed_end_ts: inBedEnd,
    asleep_h: asleep,
    in_bed_h: num(r.inBed),
    deep_h: deep,
    core_h: core,
    rem_h: rem,
    awake_h: num(r.awake),
  });
  bump(out.counts, "sleep_nights");
}

function parseWorkout(w: Record<string, unknown>): Workout | null {
  const start = parseHaeDate(w.start ?? w.startDate);
  const end = parseHaeDate(w.end ?? w.endDate);
  const name = str(w.name) || str(w.workoutActivityType) || "Workout";
  if (start == null || end == null || end <= start) return null;

  const hr = (w.heartRate ?? {}) as Record<string, unknown>;
  const energy = (w.activeEnergyBurned ?? w.activeEnergy) as unknown;
  let kcal: number | null = null;
  if (Array.isArray(energy)) {
    kcal = energy.reduce((s: number, e) => s + (num(e) ?? 0), 0) || null;
    const units = str((energy[0] as Record<string, unknown> | undefined)?.units);
    if (kcal != null) kcal = toKcal(kcal, units);
  } else if (energy != null) {
    kcal = num(energy);
    const units = str((energy as Record<string, unknown>).units);
    if (kcal != null) kcal = toKcal(kcal, units);
  }
  let avgHr = num(w.avgHeartRate) ?? num(hr.avg);
  let maxHr = num(w.maxHeartRate) ?? num(hr.max);
  if ((avgHr == null || maxHr == null) && Array.isArray(w.heartRateData) && w.heartRateData.length) {
    const pts = (w.heartRateData as Record<string, unknown>[])
      .map((p) => ({ avg: num(p.Avg ?? p.avg ?? p.qty), max: num(p.Max ?? p.max ?? p.qty) }))
      .filter((p) => p.avg != null);
    if (pts.length) {
      avgHr ??= pts.reduce((s, p) => s + (p.avg as number), 0) / pts.length;
      maxHr ??= Math.max(...pts.map((p) => (p.max ?? p.avg) as number));
    }
  }
  const dist = w.distance as Record<string, unknown> | undefined;
  let distanceKm = num(dist);
  if (distanceKm != null && /mi/i.test(str(dist?.units))) distanceKm *= 1.609344;
  if (distanceKm != null && /^m$/i.test(str(dist?.units))) distanceKm /= 1000;

  return {
    id: str(w.id) || `h:${hashSync(`${name}|${start}`)}`,
    name,
    start_ts: start,
    end_ts: end,
    local_date: localDate(start),
    duration_min: (end - start) / 60,
    active_kcal: kcal,
    avg_hr: avgHr,
    max_hr: maxHr,
    distance_km: distanceKm,
    source: str(w.source),
  };
}

function hashSync(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

// Exported for tests.
export const _internal = { parseWorkout };
