import { describe, expect, it } from "vitest";
import { busynessByDay, isTennis, normaliseEvent } from "../src/calendar/classify";
import { fmtTime } from "../src/lib/time";

describe("tennis tagging", () => {
  it("matches Liga court bookings", () => {
    expect(isTennis({ summary: "Court 2 (covered)" })).toBe(true);
    expect(isTennis({ summary: "Court 5 (OUTDOOR/ single court)" })).toBe(true);
    expect(isTennis({ summary: "Booking", location: "Liga.Tennis & Padel, Umalas" })).toBe(true);
    expect(isTennis({ summary: "Client call" })).toBe(false);
    expect(isTennis({ summary: "Food court lunch" })).toBe(false);
  });
});

describe("timezone normalisation", () => {
  it("uses the explicit offset, not the Europe/Paris or Zurich label", () => {
    const e = normaliseEvent(
      { id: "1", summary: "Call", start: { dateTime: "2026-10-05T09:00:00+02:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-10-05T10:00:00+02:00", timeZone: "Europe/Paris" } },
      "primary",
    )!;
    expect(fmtTime(e.start_ts)).toBe("15:00"); // 09:00 Paris (CEST) = 15:00 Bali
    expect(e.start_date).toBe("2026-10-05");
    const late = normaliseEvent(
      { id: "2", summary: "Late", start: { dateTime: "2026-10-05T19:00:00+02:00" }, end: { dateTime: "2026-10-05T20:00:00+02:00" } },
      "primary",
    )!;
    expect(late.start_date).toBe("2026-10-06"); // 01:00 Bali next day
  });

  it("treats all-day events as Bali days and skips cancelled/free/declined", () => {
    const allDay = normaliseEvent({ id: "3", summary: "Offsite", start: { date: "2026-10-07" }, end: { date: "2026-10-08" } }, "primary")!;
    expect(allDay.all_day).toBe(true);
    expect([allDay.start_date, allDay.end_date]).toEqual(["2026-10-07", "2026-10-07"]);
    expect(normaliseEvent({ id: "4", status: "cancelled", start: { date: "2026-10-07" }, end: { date: "2026-10-08" } }, "p")).toBeNull();
    expect(normaliseEvent({ id: "5", transparency: "transparent", start: { dateTime: "2026-10-05T09:00:00+08:00" }, end: { dateTime: "2026-10-05T10:00:00+08:00" } }, "p")!.busy).toBe(false);
    expect(normaliseEvent({ id: "6", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-10-05T09:00:00+08:00" }, end: { dateTime: "2026-10-05T10:00:00+08:00" } }, "p")!.busy).toBe(false);
    expect(normaliseEvent({ id: "7", eventType: "workingLocation", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } }, "p")!.busy).toBe(false);
  });
});

describe("busyness", () => {
  const ev = (id: string, s: string, e: string, summary = "Meeting") => normaliseEvent({ id, summary, start: { dateTime: s }, end: { dateTime: e } }, "p")!;
  it("merges overlaps, excludes tennis, flags heavy and full-day", () => {
    const events = [
      ev("a", "2026-10-05T09:00:00+08:00", "2026-10-05T11:00:00+08:00"),
      ev("b", "2026-10-05T10:00:00+08:00", "2026-10-05T12:30:00+08:00"), // overlaps a → 3.5h total
      ev("c", "2026-10-05T14:00:00+08:00", "2026-10-05T16:00:00+08:00"), // +2h → 5.5h
      ev("t", "2026-10-05T17:00:00+08:00", "2026-10-05T18:30:00+08:00", "Court 2 (covered)"),
      normaliseEvent({ id: "d", summary: "Trip", start: { date: "2026-10-06" }, end: { date: "2026-10-07" } }, "p")!,
    ];
    const [mon, tue, wed] = busynessByDay(events, "2026-10-05", "2026-10-07");
    expect(mon.hours).toBeCloseTo(5.5);
    expect(mon.heavy).toBe(true);
    expect(mon.tennis).toBe(1);
    expect(tue).toMatchObject({ fullDay: true, heavy: true, hours: 0 });
    expect(wed).toMatchObject({ hours: 0, heavy: false });
  });
});

describe("real-world calendar shapes (titles anonymised)", () => {
  // As returned by the Calendar API for a Europe/Zurich calendar: explicit +02:00
  // offsets, with timeZone labels of Europe/Paris or Asia/Makassar.
  const raw = [
    ["t1", "Court 5 (OUTDOOR/ single court)", "2026-10-03T11:00:00+02:00", "2026-10-03T12:00:00+02:00", "Asia/Makassar"],
    ["m1", "Induction day 1", "2026-10-05T04:00:00+02:00", "2026-10-05T06:00:00+02:00", "Asia/Makassar"],
    ["m2", "Induction day 1 (cont.)", "2026-10-05T08:00:00+02:00", "2026-10-05T10:00:00+02:00", "Asia/Makassar"],
    ["m3", "Day 2 a", "2026-10-06T04:00:00+02:00", "2026-10-06T05:30:00+02:00", "Asia/Makassar"],
    ["m4", "Day 2 b", "2026-10-06T05:30:00+02:00", "2026-10-06T07:00:00+02:00", "Asia/Makassar"],
    ["m5", "Day 2 c", "2026-10-06T09:00:00+02:00", "2026-10-06T11:00:00+02:00", "Asia/Makassar"],
    ["m6", "Day 4 full day", "2026-10-08T04:00:00+02:00", "2026-10-08T11:00:00+02:00", "Asia/Makassar"],
    ["t2", "Court 2 (covered)", "2026-10-02T10:00:00+02:00", "2026-10-02T11:00:00+02:00", "Europe/Paris"],
  ] as const;
  const events = raw.map(([id, summary, s, e, tz]) =>
    normaliseEvent({ id, summary, description: summary.startsWith("Court") ? "Réservation Tennis à Umalas - Liga.Tennis & Padel" : "", start: { dateTime: s, timeZone: tz }, end: { dateTime: e, timeZone: tz } }, "primary")!,
  );

  it("converts to Bali wall-clock time and tags the bookings", () => {
    const at = (id: string) => events.find((e) => e.id === `primary:${id}`)!;
    expect([fmtTime(at("t2").start_ts), at("t2").start_date, at("t2").is_tennis]).toEqual(["16:00", "2026-10-02", true]);
    expect([fmtTime(at("t1").start_ts), at("t1").is_tennis]).toEqual(["17:00", true]);
    expect([fmtTime(at("m1").start_ts), fmtTime(at("m6").end_ts)]).toEqual(["10:00", "17:00"]);
  });

  it("computes the week's busyness", () => {
    const days = busynessByDay(events, "2026-10-05", "2026-10-08");
    expect(days.map((d) => [d.date, d.hours, d.heavy, d.fullDay])).toEqual([
      ["2026-10-05", 4, false, false],
      ["2026-10-06", 5, true, false],
      ["2026-10-07", 0, false, false],
      ["2026-10-08", 7, true, true], // single 10:00–17:00 block
    ]);
  });
});
