/**
 * Training sessions and load. Pure.
 *
 * Session load (AU) = minutes × intensity (1–10), the session-RPE method.
 * Intensity = 10 × heart-rate reserve when the workout has an average HR:
 *   (avgHR − restingHR) / (maxHR − restingHR)
 * otherwise a per-activity default from config.
 *
 * Sessions come from Apple Health workouts plus tennis bookings in the
 * calendar. A booking that overlaps a racquet-sport workout is the same
 * session and is counted once (the workout wins, it has heart rate).
 * Future bookings are "planned" and never count toward load.
 */
import { config } from "../config";
import { addDays, localDate } from "../lib/time";

export interface Session {
  id: string;
  date: string;
  start_ts: number;
  end_ts: number;
  name: string;
  kind: "tennis" | "gym" | "other";
  source: "workout" | "calendar";
  minutes: number;
  intensity: number;
  load: number;
  avg_hr: number | null;
  planned: boolean;
}

export interface WorkoutLike {
  id: string;
  name: string;
  start_ts: number;
  end_ts: number;
  duration_min: number;
  avg_hr: number | null;
  max_hr: number | null;
}

export interface TennisBooking {
  id: string;
  summary: string;
  start_ts: number;
  end_ts: number;
}

const RACQUET = /tennis|padel|squash|badminton|pickleball/i;
const GYM = /strength|weight|functional|core|gym|hiit|cross/i;

export function kindOf(name: string): Session["kind"] {
  if (RACQUET.test(name)) return "tennis";
  if (GYM.test(name)) return "gym";
  return "other";
}

export function defaultIntensity(name: string): number {
  return config.training.defaultIntensity.find((d) => d.match.test(name))?.intensity ?? config.training.fallbackIntensity;
}

export function intensityFromHr(avgHr: number | null, restingHr: number | null, maxHr: number): number | null {
  if (avgHr == null || restingHr == null || maxHr <= restingHr) return null;
  const hrr = (avgHr - restingHr) / (maxHr - restingHr);
  return Math.min(10, Math.max(1, Math.round(hrr * 100) / 10));
}

export function estimateMaxHr(workouts: WorkoutLike[]): number {
  if (config.training.maxHeartRate) return config.training.maxHeartRate;
  const peak = Math.max(0, ...workouts.map((w) => w.max_hr ?? 0));
  // Only trust an observed peak that looks like real hard effort.
  return peak >= 160 ? peak : config.training.maxHeartRateFallback;
}

const overlap = (a: { start_ts: number; end_ts: number }, b: { start_ts: number; end_ts: number }) =>
  Math.max(0, Math.min(a.end_ts, b.end_ts) - Math.max(a.start_ts, b.start_ts));

export function buildSessions(
  workouts: WorkoutLike[],
  bookings: TennisBooking[],
  restingHrByDate: Map<string, number>,
  now: number,
  maxHr: number,
): Session[] {
  const sessions: Session[] = workouts.map((w) => {
    const date = localDate(w.start_ts);
    const rhr = restingHrByDate.get(date) ?? restingHrByDate.get(addDays(date, -1)) ?? null;
    const intensity = intensityFromHr(w.avg_hr, rhr, maxHr) ?? defaultIntensity(w.name);
    return {
      id: w.id,
      date,
      start_ts: w.start_ts,
      end_ts: w.end_ts,
      name: w.name,
      kind: kindOf(w.name),
      source: "workout",
      minutes: w.duration_min,
      intensity,
      load: Math.round(w.duration_min * intensity),
      avg_hr: w.avg_hr,
      planned: false,
    };
  });

  for (const b of bookings) {
    const minutes = (b.end_ts - b.start_ts) / 60;
    const dup = workouts.some((w) => RACQUET.test(w.name) && overlap(w, b) >= 0.3 * Math.min(b.end_ts - b.start_ts, w.end_ts - w.start_ts));
    if (dup) continue;
    const planned = b.start_ts > now;
    const intensity = config.calendar.tennisDefaultIntensity;
    sessions.push({
      id: b.id,
      date: localDate(b.start_ts),
      start_ts: b.start_ts,
      end_ts: b.end_ts,
      name: b.summary,
      kind: "tennis",
      source: "calendar",
      minutes,
      intensity,
      load: planned ? 0 : Math.round(minutes * intensity),
      avg_hr: null,
      planned,
    });
  }
  return sessions.sort((a, b) => a.start_ts - b.start_ts);
}

export interface LoadSummary {
  acute: number; // sum of last 7 days
  chronic: number; // weekly average over last 28 days
  acwr: number | null;
  daysOfHistory: number;
}

/** Acute (7-day) vs chronic (28-day, as weekly average) load, ending on `date` inclusive. */
export function loadSummary(sessions: Session[], date: string, firstDataDate: string | null): LoadSummary {
  const done = sessions.filter((s) => !s.planned);
  const sum = (from: string) => done.filter((s) => s.date >= from && s.date <= date).reduce((t, s) => t + s.load, 0);
  const acute = sum(addDays(date, -6));
  const chronic = sum(addDays(date, -27)) / 4;
  const daysOfHistory = firstDataDate ? Math.max(0, Math.round((Date.parse(date) - Date.parse(firstDataDate)) / 86400000) + 1) : 0;
  return {
    acute,
    chronic,
    // A ratio over less than ~3 weeks of history is mostly noise.
    acwr: chronic > 0 && daysOfHistory >= 21 ? acute / chronic : null,
    daysOfHistory,
  };
}

export interface WeekVolume {
  weekStart: string; // Monday
  tennis: number;
  gym: number;
  other: number;
  minutes: number;
  sessions: number;
}

export function weeklyVolume(sessions: Session[], weeks: number, today: string): WeekVolume[] {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  const thisMonday = addDays(today, -dow);
  const out: WeekVolume[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const ws = addDays(thisMonday, -7 * i);
    const we = addDays(ws, 6);
    const inWeek = sessions.filter((s) => !s.planned && s.date >= ws && s.date <= we);
    out.push({
      weekStart: ws,
      tennis: inWeek.filter((s) => s.kind === "tennis").reduce((t, s) => t + s.load, 0),
      gym: inWeek.filter((s) => s.kind === "gym").reduce((t, s) => t + s.load, 0),
      other: inWeek.filter((s) => s.kind === "other").reduce((t, s) => t + s.load, 0),
      minutes: Math.round(inWeek.reduce((t, s) => t + s.minutes, 0)),
      sessions: inWeek.length,
    });
  }
  return out;
}
