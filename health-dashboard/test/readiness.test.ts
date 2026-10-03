import { describe, expect, it } from "vitest";
import { acwrScore, computeReadiness, lerpScore, type ReadinessInput } from "../src/metrics/readiness";
import { buildSessions, intensityFromHr, loadSummary } from "../src/metrics/load";
import { parseHaeDate } from "../src/lib/time";

const base: ReadinessInput = {
  hrvToday: 50, hrvBaseline28: 50, hrvBaselineDays: 20,
  rhrToday: 55, rhrBaseline28: 55, rhrBaselineDays: 20,
  sleepLastNight: 7.5, sleepAvg28: 7.2, sleepBaselineDays: 20,
  acwr: 1.0, busyHoursToday: 2, busyHoursTomorrow: 2, fullDayToday: false,
};

describe("readiness", () => {
  it("linear component mapping clamps", () => {
    expect(lerpScore(0.8, 0.8, 1.05)).toBe(0);
    expect(lerpScore(1.05, 0.8, 1.05)).toBe(100);
    expect(lerpScore(2, 0.8, 1.05)).toBe(100);
    expect(lerpScore(6, 6, -2)).toBe(0);
  });

  it("is high on a normal day with nothing limiting", () => {
    const r = computeReadiness(base);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.band?.label).toBe("Ready");
    expect(r.limiter).toBeNull();
  });

  it("names the factor that pulled the score down", () => {
    const r = computeReadiness({ ...base, hrvToday: 40 }); // −20%
    expect(r.limiter?.key).toBe("hrv");
    expect(r.limiterText).toMatch(/HRV: 40 ms vs 50 ms baseline \(−20%\)/);
    expect(r.score!).toBeLessThan(computeReadiness(base).score!);
  });

  it("skips components without data and renormalises", () => {
    const r = computeReadiness({ ...base, hrvToday: null, acwr: null, busyHoursToday: null });
    expect(r.components.filter((c) => c.score == null).map((c) => c.key)).toEqual(["hrv", "load", "calendar"]);
    expect(r.score).not.toBeNull();
  });

  it("returns null without any physiological signal", () => {
    const r = computeReadiness({ ...base, hrvToday: null, rhrToday: null, sleepLastNight: null });
    expect(r.score).toBeNull();
  });

  it("ACWR sweet spot, spike and low", () => {
    expect(acwrScore(1.1)).toBe(100);
    expect(acwrScore(2.0)).toBe(0);
    expect(acwrScore(1.65)).toBe(50);
    expect(acwrScore(0.4)).toBe(70);
  });

  it("calendar heavy days cost points", () => {
    const busy = computeReadiness({ ...base, busyHoursToday: 9, fullDayToday: true });
    expect(busy.components.find((c) => c.key === "calendar")!.score).toBe(0);
  });
});

describe("training load", () => {
  it("intensity from heart-rate reserve", () => {
    expect(intensityFromHr(140, 55, 185)).toBeCloseTo(6.5, 1);
    expect(intensityFromHr(null, 55, 185)).toBeNull();
  });

  it("dedupes a tennis booking against the matching workout and keeps future bookings as planned", () => {
    const t = (s: string) => parseHaeDate(s)!;
    const workouts = [{ id: "w1", name: "Tennis", start_ts: t("2026-10-02 16:05:00 +0800"), end_ts: t("2026-10-02 17:30:00 +0800"), duration_min: 85, avg_hr: 140, max_hr: 175 }];
    const bookings = [
      { id: "b1", summary: "Court 2 (covered)", start_ts: t("2026-10-02 16:00:00 +0800"), end_ts: t("2026-10-02 17:30:00 +0800") },
      { id: "b2", summary: "Court 5 (OUTDOOR/ single court)", start_ts: t("2026-09-30 07:00:00 +0800"), end_ts: t("2026-09-30 08:30:00 +0800") },
      { id: "b3", summary: "Court 1", start_ts: t("2026-10-05 07:00:00 +0800"), end_ts: t("2026-10-05 08:30:00 +0800") },
    ];
    const s = buildSessions(workouts, bookings, new Map([["2026-10-02", 55]]), t("2026-10-03 06:30:00 +0800"), 185);
    expect(s.map((x) => x.id)).toEqual(["b2", "w1", "b3"]);
    expect(s.find((x) => x.id === "w1")!.load).toBe(Math.round(85 * 6.5));
    expect(s.find((x) => x.id === "b2")!.load).toBe(90 * 6);
    expect(s.find((x) => x.id === "b3")).toMatchObject({ planned: true, load: 0 });
    const l = loadSummary(s, "2026-10-03", "2026-09-01");
    expect(l.acute).toBe(Math.round(85 * 6.5) + 540);
    expect(l.acwr).toBeCloseTo(4, 5); // all load in the last 7 days → acute = 4 × weekly avg
  });
});
