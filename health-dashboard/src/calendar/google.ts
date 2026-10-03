import { config } from "../config";
import type { Env } from "../env";
import { logJob } from "../env";
import { nowSec } from "../lib/time";
import { normaliseEvent, type CalEvent, type GoogleEvent } from "./classify";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export function googleAuthUrl(env: Env, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  return json;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string) {
  const t = await tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!t.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and try again.");
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, refresh_token, access_token, expires_at, scope, updated_at)
     VALUES ('google', ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
       expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at`,
  )
    .bind(t.refresh_token, t.access_token, nowSec() + t.expires_in - 60, t.scope ?? GOOGLE_SCOPE, new Date().toISOString())
    .run();
}

async function accessToken(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT refresh_token, access_token, expires_at FROM oauth_tokens WHERE provider = 'google'").first<{
    refresh_token: string;
    access_token: string | null;
    expires_at: number | null;
  }>();
  if (!row) return null;
  if (row.access_token && (row.expires_at ?? 0) > nowSec()) return row.access_token;
  const t = await tokenRequest({
    refresh_token: row.refresh_token,
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
  });
  await env.DB.prepare("UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE provider = 'google'")
    .bind(t.access_token, nowSec() + t.expires_in - 60, new Date().toISOString())
    .run();
  return t.access_token;
}

export async function isGoogleConnected(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM oauth_tokens WHERE provider = 'google'").first());
}

async function listEvents(token: string, calendarId: string, timeMin: string, timeMax: string): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true", // expand recurring events
      orderBy: "startTime",
      maxResults: "2500",
      timeZone: config.timezone, // returned dateTimes are expressed in Bali time (offset still explicit)
    });
    if (pageToken) p.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${p}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Calendar API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    out.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

/** Pull past 28 / next 14 days and mirror them into calendar_events. */
export async function syncCalendar(env: Env): Promise<{ events: number; tennis: number } | null> {
  const token = await accessToken(env);
  if (!token) return null;
  const now = nowSec();
  const fromTs = now - config.calendar.pastDays * 86400;
  const toTs = now + config.calendar.futureDays * 86400;
  const timeMin = new Date(fromTs * 1000).toISOString();
  const timeMax = new Date(toTs * 1000).toISOString();
  const syncedAt = new Date().toISOString();

  let total = 0;
  let tennis = 0;
  for (const calId of config.calendar.calendarIds) {
    const raw = await listEvents(token, calId, timeMin, timeMax);
    const events = raw.map((e) => normaliseEvent(e, calId)).filter((e): e is CalEvent => !!e);
    const stmt = env.DB.prepare(
      `INSERT INTO calendar_events (id, calendar_id, summary, location, start_ts, end_ts, all_day, start_date, end_date, busy, is_tennis, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET summary = excluded.summary, location = excluded.location, start_ts = excluded.start_ts,
         end_ts = excluded.end_ts, all_day = excluded.all_day, start_date = excluded.start_date, end_date = excluded.end_date,
         busy = excluded.busy, is_tennis = excluded.is_tennis, synced_at = excluded.synced_at`,
    );
    const stmts = events.map((e) =>
      stmt.bind(e.id, e.calendar_id, e.summary, e.location, e.start_ts, e.end_ts, e.all_day ? 1 : 0, e.start_date, e.end_date, e.busy ? 1 : 0, e.is_tennis ? 1 : 0, syncedAt),
    );
    // Anything in the window we didn't just see was deleted or cancelled upstream.
    stmts.push(
      env.DB.prepare("DELETE FROM calendar_events WHERE calendar_id = ? AND end_ts > ? AND start_ts < ? AND synced_at <> ?").bind(calId, fromTs, toTs, syncedAt),
    );
    for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
    total += events.length;
    tennis += events.filter((e) => e.is_tennis).length;
  }
  await logJob(env, "calendar", true, `${total} events, ${tennis} tennis`);
  return { events: total, tennis };
}
