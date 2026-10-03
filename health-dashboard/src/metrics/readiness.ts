/**
 * Readiness score, 0–100. Pure; all knobs are in config.readiness.
 *
 *   score = Σ(weight_i × component_i) / Σ(weight_i)   over components that have data
 *
 * Each component is a linear map from a measurement to 0–100 between a "bad"
 * and a "good" anchor, clamped:
 *   hrv        last-night HRV ÷ 28-day baseline          0.80 → 0,  1.05 → 100
 *   restingHr  resting HR − 28-day baseline (bpm)        +6 → 0,    −2 → 100
 *   sleep      ½ × (last night ÷ 28-day avg: 0.7 → 0, 1.05 → 100)
 *            + ½ × (hours: 5 → 0, 7.5 → 100)
 *   load       acute:chronic ratio — 100 inside 0.8–1.3, → 0 at 2.0, → 70 at 0.4
 *   calendar   today's busy hours + ½ × tomorrow's (+6 if today is a full-day block)
 *                                                       10 → 0,    3 → 100
 *
 * The "limiter" is the component costing the most points:
 *   weight × (100 − component score).
 */
import { config } from "../config";

const R = config.readiness;

export const lerpScore = (x: number, bad: number, good: number) =>
  Math.round(Math.min(100, Math.max(0, ((x - bad) / (good - bad)) * 100)));

export interface ReadinessInput {
  hrvToday: number | null;
  hrvBaseline28: number | null;
  hrvBaselineDays: number;
  rhrToday: number | null;
  rhrBaseline28: number | null;
  rhrBaselineDays: number;
  sleepLastNight: number | null;
  sleepAvg28: number | null;
  sleepBaselineDays: number;
  acwr: number | null;
  busyHoursToday: number | null;
  busyHoursTomorrow: number | null;
  fullDayToday: boolean;
}

export type ComponentKey = keyof typeof R.weights;

export interface Component {
  key: ComponentKey;
  label: string;
  score: number | null;
  weight: number;
  detail: string;
}

export interface Readiness {
  score: number | null;
  band: { label: string; tone: string } | null;
  components: Component[];
  limiter: Component | null;
  limiterText: string | null;
}

const pct = (r: number) => `${r >= 1 ? "+" : "−"}${Math.abs(Math.round((r - 1) * 100))}%`;

export function acwrScore(acwr: number): number {
  const [lo, hi] = config.training.acwrSweetSpot;
  if (acwr >= lo && acwr <= hi) return 100;
  if (acwr > hi) return lerpScore(acwr, R.acwr.high, hi);
  // Below the sweet spot: from lowFloor at `low` up to 100 at `lo`.
  const t = Math.min(1, Math.max(0, (acwr - R.acwr.low) / (lo - R.acwr.low)));
  return Math.round(R.acwr.lowFloor + t * (100 - R.acwr.lowFloor));
}

export function computeReadiness(i: ReadinessInput): Readiness {
  const w = R.weights;
  const comps: Component[] = [];

  if (i.hrvToday != null && i.hrvBaseline28 && i.hrvBaselineDays >= R.minBaselineDays) {
    const ratio = i.hrvToday / i.hrvBaseline28;
    comps.push({
      key: "hrv", label: "HRV", weight: w.hrv,
      score: lerpScore(ratio, R.hrvRatio.bad, R.hrvRatio.good),
      detail: `${Math.round(i.hrvToday)} ms vs ${Math.round(i.hrvBaseline28)} ms baseline (${pct(ratio)})`,
    });
  } else {
    comps.push({ key: "hrv", label: "HRV", weight: w.hrv, score: null, detail: i.hrvToday == null ? "No reading yet" : "Building baseline" });
  }

  if (i.rhrToday != null && i.rhrBaseline28 && i.rhrBaselineDays >= R.minBaselineDays) {
    const delta = i.rhrToday - i.rhrBaseline28;
    comps.push({
      key: "restingHr", label: "Resting HR", weight: w.restingHr,
      score: lerpScore(delta, R.restingHrDelta.bad, R.restingHrDelta.good),
      detail: `${Math.round(i.rhrToday)} bpm vs ${Math.round(i.rhrBaseline28)} baseline (${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)})`,
    });
  } else {
    comps.push({ key: "restingHr", label: "Resting HR", weight: w.restingHr, score: null, detail: i.rhrToday == null ? "No reading yet" : "Building baseline" });
  }

  if (i.sleepLastNight != null) {
    const abs = lerpScore(i.sleepLastNight, R.sleepHours.bad, R.sleepHours.good);
    const haveAvg = i.sleepAvg28 && i.sleepBaselineDays >= R.minBaselineDays;
    const rel = haveAvg ? lerpScore(i.sleepLastNight / i.sleepAvg28!, R.sleepVsAverage.bad, R.sleepVsAverage.good) : abs;
    comps.push({
      key: "sleep", label: "Sleep", weight: w.sleep,
      score: Math.round((abs + rel) / 2),
      detail: `${fmtH(i.sleepLastNight)}${haveAvg ? ` vs ${fmtH(i.sleepAvg28!)} average` : ""}, target ${fmtH(config.sleep.targetHours)}`,
    });
  } else {
    comps.push({ key: "sleep", label: "Sleep", weight: w.sleep, score: null, detail: "No sleep data for last night" });
  }

  if (i.acwr != null) {
    const [lo, hi] = config.training.acwrSweetSpot;
    comps.push({
      key: "load", label: "Training load", weight: w.load,
      score: acwrScore(i.acwr),
      detail: `Acute:chronic ${i.acwr.toFixed(2)} (sweet spot ${lo}–${hi})`,
    });
  } else {
    comps.push({ key: "load", label: "Training load", weight: w.load, score: null, detail: "Needs ~3 weeks of history" });
  }

  if (i.busyHoursToday != null) {
    const eff = i.busyHoursToday + 0.5 * (i.busyHoursTomorrow ?? 0) + (i.fullDayToday ? 6 : 0);
    comps.push({
      key: "calendar", label: "Calendar", weight: w.calendar,
      score: lerpScore(eff, R.calendarHours.bad, R.calendarHours.good),
      detail: `${fmtH(i.busyHoursToday)} booked today${i.fullDayToday ? " (full-day block)" : ""}, ${fmtH(i.busyHoursTomorrow ?? 0)} tomorrow`,
    });
  } else {
    comps.push({ key: "calendar", label: "Calendar", weight: w.calendar, score: null, detail: "Calendar not connected" });
  }

  const scored = comps.filter((c) => c.score != null);
  // Without at least one physiological signal the number would be meaningless.
  const physio = scored.some((c) => c.key === "hrv" || c.key === "restingHr" || c.key === "sleep");
  const totalW = scored.reduce((t, c) => t + c.weight, 0);
  const score = physio && totalW > 0 ? Math.round(scored.reduce((t, c) => t + c.weight * c.score!, 0) / totalW) : null;

  let limiter: Component | null = null;
  for (const c of scored) {
    const cost = c.weight * (100 - c.score!);
    if (cost > 0 && (!limiter || cost > limiter.weight * (100 - limiter.score!))) limiter = c;
  }
  if (limiter && limiter.score! >= 80) limiter = null; // nothing really pulling it down
  const band = score == null ? null : R.bands.find((b) => score >= b.min) ?? null;
  return {
    score,
    band: band ? { label: band.label, tone: band.tone } : null,
    components: comps,
    limiter,
    limiterText: limiter ? `${limiter.label}: ${limiter.detail}` : null,
  };
}

export function fmtH(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm === 60 ? `${hh + 1}h00` : `${hh}h${String(mm).padStart(2, "0")}`;
}
