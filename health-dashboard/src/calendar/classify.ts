/**
 * Google Calendar event → normalised row, tennis tagging and busyness. Pure.
 *
 * Timezones: Google returns timed events as RFC 3339 with an explicit offset
 * (e.g. "2026-10-03T09:00:00+02:00" for an event labelled Europe/Paris). We
 * parse the instant from that offset and ignore the label, then bucket into the
 * home timezone, so the Zurich calendar default and Paris-labelled events land
 * on the right Bali wall-clock time. All-day events are calendar dates, taken
 * as home-timezone days.
 */
import { config } from "../config";
import { dateRange, localDate, startOfLocalDay } from "../lib/time";

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  transparency?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

export interface CalEvent {
  id: string;
  calendar_id: string;
  summary: string;
  location: string;
  start_ts: number;
  end_ts: number;
  all_day: boolean;
  start_date: string;
  end_date: string;
  busy: boolean;
  is_tennis: boolean;
}

export function isTennis(e: Pick<GoogleEvent, "summary" | "location" | "description">): boolean {
  const hay = [e.summary, e.location, e.description].filter(Boolean).join("\n");
  return config.calendar.tennisPatterns.some((re) => re.test(hay));
}

export function normaliseEvent(e: GoogleEvent, calendarId: string): CalEvent | null {
  if (!e.start || !e.end || e.status === "cancelled") return null;
  let start: number, end: number, allDay: boolean;
  if (e.start.dateTime && e.end.dateTime) {
    start = Math.floor(Date.parse(e.start.dateTime) / 1000);
    end = Math.floor(Date.parse(e.end.dateTime) / 1000);
    allDay = false;
  } else if (e.start.date && e.end.date) {
    start = startOfLocalDay(e.start.date);
    end = startOfLocalDay(e.end.date); // exclusive
    allDay = true;
  } else {
    return null;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const declined = e.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false;
  const nonBlocking = ["workingLocation", "birthday", "outOfOffice"].includes(e.eventType ?? "");
  return {
    id: `${calendarId}:${e.id}`,
    calendar_id: calendarId,
    summary: e.summary ?? "(no title)",
    location: e.location ?? "",
    start_ts: start,
    end_ts: end,
    all_day: allDay,
    start_date: localDate(start),
    end_date: localDate(Math.max(start, end - 1)),
    busy: !declined && !nonBlocking && e.transparency !== "transparent",
    is_tennis: !allDay && isTennis(e),
  };
}

export interface DayLoad {
  date: string;
  hours: number; // merged busy hours from timed, non-tennis events
  fullDay: boolean; // all-day busy event, or a very long timed block
  heavy: boolean;
  events: number;
  tennis: number;
}

type EventLike = Pick<CalEvent, "start_ts" | "end_ts" | "all_day" | "start_date" | "end_date" | "busy" | "is_tennis">;

/** Booked hours per local day (overlaps merged, tennis excluded). */
export function busynessByDay(events: EventLike[], from: string, to: string): DayLoad[] {
  return dateRange(from, to).map((date) => {
    const dayStart = startOfLocalDay(date);
    const dayEnd = dayStart + 86400;
    const onDay = events.filter((e) => e.start_ts < dayEnd && e.end_ts > dayStart);
    const busy = onDay.filter((e) => e.busy && !e.is_tennis);
    const fullDayAllDay = busy.some((e) => e.all_day);
    const intervals = busy
      .filter((e) => !e.all_day)
      .map((e) => [Math.max(e.start_ts, dayStart), Math.min(e.end_ts, dayEnd)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let longest = 0;
    let cur: [number, number] | null = null;
    for (const iv of intervals) {
      if (cur && iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
      else {
        if (cur) total += cur[1] - cur[0];
        cur = [...iv];
      }
      longest = Math.max(longest, iv[1] - iv[0]);
    }
    if (cur) total += cur[1] - cur[0];
    const hours = total / 3600;
    const fullDay = fullDayAllDay || longest / 3600 >= config.calendar.fullDayBlockHours;
    return {
      date,
      hours,
      fullDay,
      heavy: fullDay || hours >= config.calendar.heavyDayHours,
      events: busy.length,
      tennis: onDay.filter((e) => e.is_tennis && !e.all_day).length,
    };
  });
}
