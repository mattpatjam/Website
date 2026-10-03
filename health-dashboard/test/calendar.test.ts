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
