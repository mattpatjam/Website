import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseHaePayload } from "../src/ingest/parse";
import { computeDay, nightFromSegments } from "../src/metrics/daily";
import { parseHaeDate, localDate, nightDateFor } from "../src/lib/time";

const load = (f: string) => JSON.parse(readFileSync(`${__dirname}/fixtures/${f}`, "utf8"));

describe("time", () => {
  it("parses HAE dates with offsets", () => {
    expect(parseHaeDate("2026-10-03 06:20:00 +0800")).toBe(Date.parse("2026-10-02T22:20:00Z") / 1000);
    expect(parseHaeDate("2026-10-03T06:20:00+02:00")).toBe(Date.parse("2026-10-03T04:20:00Z") / 1000);
    expect(parseHaeDate("garbage")).toBeNull();
  });
  it("buckets into Bali dates and assigns nights to the wake date", () => {
    expect(localDate(Date.parse("2026-10-02T16:30:00Z") / 1000)).toBe("2026-10-03"); // 00:30 Bali
    expect(nightDateFor(Date.parse("2026-10-02T15:30:00Z") / 1000)).toBe("2026-10-03"); // 23:30 Bali → next morning
    expect(nightDateFor(Date.parse("2026-10-03T07:00:00Z") / 1000)).toBe("2026-10-03"); // 15:00 nap → same day
  });
});

describe("parseHaePayload (summarised)", () => {
  const p = parseHaePayload(load("hae-summarized.json"));

  it("maps metrics and normalises units", () => {
    expect(p.counts.resting_hr).toBe(2);
    expect(p.counts.hrv).toBe(2);
    const spo2 = p.samples.filter((s) => s.metric === "spo2").map((s) => s.value);
    expect(spo2).toEqual([96, 94, 99]); // fraction → %
    const kcal = p.samples.find((s) => s.metric === "active_kcal")!;
    expect(kcal.value).toBeCloseTo(500, 0); // kJ → kcal
    const hr = p.samples.find((s) => s.metric === "heart_rate")!;
    expect([hr.value, hr.value_min, hr.value_max]).toEqual([58, 52, 66]);
    expect(p.skipped.dietary_water).toBe(1);
  });

  it("parses a summarised sleep night onto the wake date, deriving total from stages", () => {
    expect(p.sleepSummaries).toHaveLength(1);
    const s = p.sleepSummaries[0];
    expect(s.night_date).toBe("2026-10-03");
    expect(s.asleep_h).toBeCloseTo(6.5);
  });

  it("parses v2 and v1 workouts", () => {
    const [tennis, gym] = p.workouts;
    expect(tennis).toMatchObject({ id: "A1B2C3", name: "Tennis", duration_min: 90, avg_hr: 138, max_hr: 171, active_kcal: 650, local_date: "2026-10-02" });
    expect(gym.id).toMatch(/^h:/);
    expect(gym.avg_hr).toBe(115);
    expect(gym.max_hr).toBe(150);
    expect(gym.active_kcal).toBeCloseTo(286.8, 0);
  });

  it("produces stable ids so re-sent workouts upsert", () => {
    const again = parseHaePayload(load("hae-summarized.json"));
    expect(again.workouts.map((w) => w.id)).toEqual(p.workouts.map((w) => w.id));
  });

  it("computes the daily row", () => {
    const samples = p.samples;
    const d = computeDay("2026-10-03", samples, p.sleepSummaries, []);
    expect(d.sleep_h).toBeCloseTo(6.5);
    expect(d.resting_hr).toBe(57);
    expect(d.hrv).toBeCloseTo(44.5);
    expect(d.hrv_n).toBe(2);
    expect(d.spo2).toBe(95); // only samples inside the sleep window
    expect(d.spo2_min).toBe(94);
    const d2 = computeDay("2026-10-02", samples, [], []);
    expect(d2.steps).toBe(7500); // max of per-source totals, not 12700
  });
});

describe("parseHaePayload (segments)", () => {
  const p = parseHaePayload(load("hae-segments.json"));
  it("parses stage segments", () => {
    expect(p.sleepSegments).toHaveLength(7);
    expect(new Set(p.sleepSegments.map((s) => s.night_date))).toEqual(new Set(["2026-10-03"]));
  });
  it("builds the main night and ignores the afternoon nap", () => {
    const n = nightFromSegments(p.sleepSegments)!;
    expect(n.asleep_h).toBeCloseTo(6.5);
    expect(n.deep_h).toBeCloseTo(1);
    expect(n.rem_h).toBeCloseTo(1.5);
    expect(n.awake_h).toBeCloseTo(1 / 3);
    expect(n.bed_ts).toBe(parseHaeDate("2026-10-02 23:10:00 +0800"));
    expect(n.wake_ts).toBe(parseHaeDate("2026-10-03 06:00:00 +0800"));
    expect(n.in_bed_h).toBeCloseTo(7);
  });
});
