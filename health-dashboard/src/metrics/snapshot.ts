/**
 * Loads everything for one "as of" date and derives all metrics the dashboard
 * and the recommendation prompt need.
 */
import type { Env } from "../env";
import { busynessByDay, type DayLoad } from "../calendar/classify";
import { addDays, dateRange, localDate, localParts, nowSec } from "../lib/time";
import type { DailyRow } from "./daily";
import { buildSessions, estimateMaxHr, loadSummary, weeklyVolume, type LoadSummary, type Session, type WeekVolume, type WorkoutLike } from "./load";
import { computeReadiness, type Readiness } from "./readiness";

export interface CalendarRow {
  id: string;
  summary: string;
  location: string;
  start_ts: number;
  end_ts: number;
  all_day: number;
  start_date: string;
  end_date: string;
  busy: number;
  is_tennis: number;
}

export interface Baselines {
  hrv7: number | null;
  hrv28: number | null;
  hrvDays: number;
  rhr7: number | null;
  rhr28: number | null;
  rhrDays: number;
  sleep7: number | null;
  sleep28: number | null;
  sleepDays: number;
}

export interface Snapshot {
  today: string;
  days: DailyRow[]; // oldest → newest, contiguous, ending today
  baselines: Baselines;
  readiness: Readiness;
  readinessHistory: { date: string; score: number | null }[];
  sessions: Session[];
  load: LoadSummary;
  weekly: WeekVolume[];
  busyness: DayLoad[]; // today … today+6
  upcoming: CalendarRow[]; // next 7 days, all events
  sleepConsistency: { bedSdMin: number | null; wakeSdMin: number | null; nights: number };
  freshness: { lastIngest: string | null; lastCalendar: string | null; lastHealthSample: number | null };
}

const avg = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const count = (xs: (number | null | undefined)[]) => xs.filter((x) => x != null).length;

function sd(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / xs.length);
}

/** Minutes after local noon (so 23:30 and 00:30 are 60 min apart, not 23 h). */
function minutesFromNoon(ts: number): number {
  const p = localParts(ts);
  return (((p.hour - 12 + 24) % 24) * 60) + p.minute;
}

export function baselinesFor(byDate: Map<string, DailyRow>, date: string): Baselines {
  const prior = (n: number) => dateRange(addDays(date, -n), addDays(date, -1)).map((d) => byDate.get(d));
  const p7 = prior(7);
  const p28 = prior(28);
  return {
    hrv7: avg(p7.map((r) => r?.hrv)),
    hrv28: avg(p28.map((r) => r?.hrv)),
    hrvDays: count(p28.map((r) => r?.hrv)),
    rhr7: avg(p7.map((r) => r?.resting_hr)),
    rhr28: avg(p28.map((r) => r?.resting_hr)),
    rhrDays: count(p28.map((r) => r?.resting_hr)),
    sleep7: avg(p7.map((r) => r?.sleep_h)),
    sleep28: avg(p28.map((r) => r?.sleep_h)),
    sleepDays: count(p28.map((r) => r?.sleep_h)),
  };
}

function emptyDay(date: string): DailyRow {
  return {
    date, sleep_h: null, in_bed_h: null, deep_h: null, core_h: null, rem_h: null, awake_h: null, bed_ts: null, wake_ts: null,
    resting_hr: null, hrv: null, hrv_n: 0, spo2: null, spo2_min: null, steps: null, active_kcal: null,
  };
}

/** Today's value if present, else yesterday's (HRV/RHR may not have arrived yet at 06:30). */
function latest(byDate: Map<string, DailyRow>, date: string, key: "hrv" | "resting_hr"): number | null {
  return byDate.get(date)?.[key] ?? byDate.get(addDays(date, -1))?.[key] ?? null;
}

export function readinessFor(
  date: string,
  byDate: Map<string, DailyRow>,
  sessions: Session[],
  firstDataDate: string | null,
  busy: Map<string, DayLoad> | null,
): Readiness {
  const b = baselinesFor(byDate, date);
  const load = loadSummary(sessions, date, firstDataDate);
  const t = busy?.get(date);
  return computeReadiness({
    hrvToday: latest(byDate, date, "hrv"),
    hrvBaseline28: b.hrv28,
    hrvBaselineDays: b.hrvDays,
    rhrToday: latest(byDate, date, "resting_hr"),
    rhrBaseline28: b.rhr28,
    rhrBaselineDays: b.rhrDays,
    sleepLastNight: byDate.get(date)?.sleep_h ?? null,
    sleepAvg28: b.sleep28,
    sleepBaselineDays: b.sleepDays,
    acwr: load.acwr,
    busyHoursToday: busy ? t?.hours ?? 0 : null,
    busyHoursTomorrow: busy ? busy.get(addDays(date, 1))?.hours ?? 0 : null,
    fullDayToday: t?.fullDay ?? false,
  });
}

export async function buildSnapshot(env: Env, today = localDate(nowSec()), calendarConnected = true): Promise<Snapshot> {
  const db = env.DB;
  const historyDays = 56; // 28-day baselines for each of the last 28 days
  const from = addDays(today, -historyDays + 1);
  const now = nowSec();

  const [dailyRes, workoutsRes, eventsRes, firstRes, ingestRes, calRes, lastSampleRes] = await Promise.all([
    db.prepare("SELECT * FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date").bind(from, today).all<DailyRow>(),
    db.prepare("SELECT id, name, start_ts, end_ts, duration_min, avg_hr, max_hr FROM workouts WHERE local_date >= ? ORDER BY start_ts")
      .bind(addDays(today, -120)).all<WorkoutLike & { local_date: string }>(),
    db.prepare("SELECT * FROM calendar_events WHERE end_ts > ? AND start_ts < ? ORDER BY start_ts")
      .bind(now - 60 * 86400, now + 15 * 86400).all<CalendarRow>(),
    db.prepare("SELECT MIN(d) AS d FROM (SELECT MIN(date) AS d FROM daily_metrics UNION ALL SELECT MIN(local_date) FROM workouts UNION ALL SELECT MIN(start_date) FROM calendar_events WHERE is_tennis = 1)")
      .first<{ d: string | null }>(),
    db.prepare("SELECT received_at FROM raw_payloads WHERE status = 'parsed' ORDER BY id DESC LIMIT 1").first<{ received_at: string }>(),
    db.prepare("SELECT at FROM job_log WHERE kind = 'calendar' AND ok = 1 ORDER BY id DESC LIMIT 1").first<{ at: string }>(),
    db.prepare("SELECT MAX(ts) AS ts FROM samples").first<{ ts: number | null }>(),
  ]);

  const byDate = new Map(dailyRes.results.map((r) => [r.date, r]));
  const days = dateRange(from, today).map((d) => byDate.get(d) ?? emptyDay(d));
  const restingByDate = new Map(days.filter((d) => d.resting_hr != null).map((d) => [d.date, d.resting_hr!]));

  const events = eventsRes.results;
  const bookings = events.filter((e) => e.is_tennis && !e.all_day).map((e) => ({ id: e.id, summary: e.summary, start_ts: e.start_ts, end_ts: e.end_ts }));
  const workouts = workoutsRes.results;
  const sessions = buildSessions(workouts, bookings, restingByDate, now, estimateMaxHr(workouts));

  const evLike = events.map((e) => ({ ...e, all_day: !!e.all_day, busy: !!e.busy, is_tennis: !!e.is_tennis }));
  const busyAll = calendarConnected ? busynessByDay(evLike, addDays(today, -28), addDays(today, 7)) : null;
  const busyMap = busyAll ? new Map(busyAll.map((d) => [d.date, d])) : null;

  const firstDataDate = firstRes?.d ?? null;
  const readiness = readinessFor(today, byDate, sessions, firstDataDate, busyMap);
  const readinessHistory = dateRange(addDays(today, -13), today).map((d) => ({
    date: d,
    score: d === today ? readiness.score : readinessFor(d, byDate, sessions, firstDataDate, busyMap).score,
  }));

  const last7 = dateRange(addDays(today, -6), today).map((d) => byDate.get(d)).filter((r): r is DailyRow => !!r);
  const beds = last7.filter((r) => r.bed_ts).map((r) => minutesFromNoon(r.bed_ts!));
  const wakes = last7.filter((r) => r.wake_ts).map((r) => minutesFromNoon(r.wake_ts!));

  return {
    today,
    days: days.slice(-28),
    baselines: baselinesFor(byDate, today),
    readiness,
    readinessHistory,
    sessions: sessions.filter((s) => s.date >= addDays(today, -41)),
    load: loadSummary(sessions, today, firstDataDate),
    weekly: weeklyVolume(sessions, 6, today),
    busyness: busyAll ? busyAll.filter((d) => d.date >= today && d.date <= addDays(today, 6)) : [],
    upcoming: events.filter((e) => e.end_ts > now && e.start_date <= addDays(today, 6)),
    sleepConsistency: { bedSdMin: sd(beds), wakeSdMin: sd(wakes), nights: Math.max(beds.length, wakes.length) },
    freshness: { lastIngest: ingestRes?.received_at ?? null, lastCalendar: calRes?.at ?? null, lastHealthSample: lastSampleRes?.ts ?? null },
  };
}

/** Persist the readiness score for today (history page / prompt). */
export async function storeReadiness(env: Env, s: Snapshot) {
  await env.DB.prepare(
    `INSERT INTO readiness (date, score, components, limiter, computed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (date) DO UPDATE SET score = excluded.score, components = excluded.components, limiter = excluded.limiter, computed_at = excluded.computed_at`,
  )
    .bind(s.today, s.readiness.score, JSON.stringify(s.readiness.components), s.readiness.limiterText, new Date().toISOString())
    .run();
}

