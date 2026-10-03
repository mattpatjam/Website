/**
 * Everything you are likely to want to tweak lives here.
 * Change a value, run `npm run deploy`, done.
 *
 * Your personal training context (injuries, preferences) is NOT in this file:
 * it is edited on the dashboard's Settings page and stored in the database,
 * so it never ends up in git.
 */

export const config = {
  /** All dates/times are shown and bucketed in this timezone. */
  timezone: "Asia/Makassar",

  /** Morning recommendation run, local time (HH:MM). */
  morningRunAt: "06:30",
  /** If last night's sleep hasn't arrived yet, keep retrying until this time, then run anyway. */
  morningRunLatest: "10:00",

  calendar: {
    /** Google Calendar ids to read. "primary" = your main calendar. */
    calendarIds: ["primary"],
    pastDays: 28,
    futureDays: 14,
    /** An event is a tennis session if any of these match title, location or description. */
    tennisPatterns: [/^\s*court\s*\d+/i, /liga\.?\s*tennis/i, /\btennis\b/i, /\bpadel\b/i],
    /** Default intensity (1–10) for a tennis booking without a matching Apple Health workout. */
    tennisDefaultIntensity: 6,
    /** A day is "heavy" at or above this many booked (non-tennis) hours. */
    heavyDayHours: 5,
    /** A single timed event this long or longer counts as a full-day block (e.g. 10:00–17:00). */
    fullDayBlockHours: 7,
  },

  training: {
    /**
     * Session load = minutes × intensity (1–10), i.e. session-RPE "arbitrary units".
     * Intensity comes from average heart rate when available (heart-rate reserve × 10),
     * otherwise from these defaults by workout name.
     */
    defaultIntensity: [
      { match: /tennis|padel|squash|badminton|pickleball/i, intensity: 6 },
      { match: /strength|weight|functional|core|gym|hiit|cross/i, intensity: 5 },
      { match: /run|cycl|bike|swim|row/i, intensity: 6 },
      { match: /walk|hike/i, intensity: 2.5 },
      { match: /yoga|pilates|mobility|stretch|flexibility|cooldown/i, intensity: 2 },
    ],
    fallbackIntensity: 4,
    /** Leave null to estimate from the highest workout heart rate seen in the last 120 days. */
    maxHeartRate: null as number | null,
    /** Used when maxHeartRate is null and there isn't enough workout data yet. */
    maxHeartRateFallback: 185,
    /** Acute:chronic workload ratio sweet spot. */
    acwrSweetSpot: [0.8, 1.3] as [number, number],
  },

  sleep: {
    /** Personal nightly target, used in readiness and given to Claude. */
    targetHours: 7.5,
  },

  /**
   * Readiness score (0–100) = weighted average of component scores.
   * Each component maps a measurement linearly between a "bad" point (score 0)
   * and a "good" point (score 100), clamped. Components with no data are skipped
   * and the remaining weights re-normalised.
   * See README.md → "Readiness score" for the reasoning.
   */
  readiness: {
    weights: {
      hrv: 30,
      restingHr: 20,
      sleep: 25,
      load: 15,
      calendar: 10,
    },
    /** Need at least this many days of history before a baseline is trusted. */
    minBaselineDays: 5,
    /** Last-night HRV ÷ 28-day baseline. */
    hrvRatio: { bad: 0.8, good: 1.05 },
    /** Resting HR minus 28-day baseline, in bpm. Lower is better. */
    restingHrDelta: { bad: 6, good: -2 },
    /** Last night's sleep ÷ your 28-day average (half of the sleep score). */
    sleepVsAverage: { bad: 0.7, good: 1.05 },
    /** Last night's sleep in hours vs absolute target (other half). */
    sleepHours: { bad: 5, good: 7.5 },
    /**
     * ACWR: 100 inside the sweet spot; falls to 0 at `high`; falls to `lowFloor` at `low`
     * (under-training is not fatigue, so it is only mildly penalised).
     */
    acwr: { low: 0.4, lowFloor: 70, high: 2.0 },
    /** Busy hours = today + 0.5 × tomorrow (+ 6 h for a full-day block today). */
    calendarHours: { bad: 10, good: 3 },
    /** Score bands for the colour / label. */
    bands: [
      { min: 75, label: "Ready", tone: "good" },
      { min: 55, label: "Moderate", tone: "warning" },
      { min: 0, label: "Take it easy", tone: "critical" },
    ],
  },
} as const;

export type Config = typeof config;
