import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "./env";
import { getSetting, logJob, setSetting } from "./env";
import { exchangeCode, googleAuthUrl, isGoogleConnected, syncCalendar } from "./calendar/google";
import { parseHaePayload } from "./ingest/parse";
import { markRaw, storeParsed, storeRaw } from "./ingest/store";
import { maybeGenerateRecommendations, scheduled } from "./jobs";
import { SESSION_COOKIE, isLockedOut, makeSession, makeState, recordAttempt, safeEqual, verifySession, verifyState } from "./lib/auth";
import { localDate, nowSec } from "./lib/time";
import { recomputeDays } from "./metrics/daily";
import { buildSnapshot, storeReadiness } from "./metrics/snapshot";
import { latestRecommendation, recommendationHistory } from "./recs/claude";
import { DEFAULT_TRAINING_CONTEXT } from "./recs/context";
import { APP_JS } from "./ui/layout";
import { dashboardPage, historyPage, loginPage, settingsPage } from "./ui/pages";

type App = { Bindings: Env };
const app = new Hono<App>();

// ---------- security headers on every response ----------
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  h.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
});

// HTTPS only (workers.dev and custom domains are HTTPS, but refuse plain HTTP anyway).
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    url.protocol = "https:";
    return c.redirect(url.toString(), 301);
  }
  await next();
});

app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
app.get("/app.js", (c) => c.body(APP_JS, 200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" }));

// ---------- Health Auto Export ingest ----------
app.post("/api/ingest", async (c) => {
  const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-ingest-token") ?? "";
  if (!c.env.INGEST_TOKEN || !(await safeEqual(auth, c.env.INGEST_TOKEN))) return c.json({ error: "unauthorized" }, 401);

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (!body.length) return c.json({ error: "empty body" }, 400);

  const { id, duplicate } = await storeRaw(c.env, body);
  if (duplicate) return c.json({ ok: true, duplicate: true, payload_id: id });

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    await markRaw(c.env, id, "error", null, "invalid JSON");
    await logJob(c.env, "ingest", false, `payload ${id}: invalid JSON`);
    return c.json({ error: "invalid JSON", payload_id: id }, 400);
  }

  try {
    const parsed = parseHaePayload(json);
    const touched = await storeParsed(c.env, parsed);
    await recomputeDays(c.env, touched);
    const summary = { counts: parsed.counts, skipped: parsed.skipped, dates: [...touched].sort() };
    await markRaw(c.env, id, "parsed", summary);
    await logJob(c.env, "ingest", true, `payload ${id}: ${Object.entries(parsed.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing recognised"}`);
    // Morning push with last night's sleep may be the trigger for today's plan.
    c.executionCtx.waitUntil(maybeGenerateRecommendations(c.env).catch((e) => console.error("recs", e)));
    return c.json({ ok: true, payload_id: id, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markRaw(c.env, id, "error", null, msg);
    await logJob(c.env, "ingest", false, `payload ${id}: ${msg}`);
    return c.json({ error: "processing failed", payload_id: id }, 500);
  }
});

// ---------- login ----------
app.get("/login", (c) => c.html(loginPage()));

app.post("/login", async (c) => {
  if (await isLockedOut(c.env)) return c.html(loginPage("Too many attempts. Try again in 15 minutes."), 429);
  const form = await c.req.parseBody();
  const ok = !!c.env.DASHBOARD_PASSWORD && (await safeEqual(String(form.password ?? ""), c.env.DASHBOARD_PASSWORD));
  await recordAttempt(c.env, ok);
  if (!ok) return c.html(loginPage("Wrong password."), 401);
  const s = await makeSession(c.env);
  setCookie(c, SESSION_COOKIE, s.value, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: s.maxAge });
  return c.redirect("/");
});

// ---------- everything below requires a session ----------
app.use("*", async (c, next) => {
  if (!(await verifySession(c.env, getCookie(c, SESSION_COOKIE)))) {
    return c.req.method === "GET" ? c.redirect("/login") : c.text("unauthorized", 401);
  }
  // CSRF: state-changing requests must come from our own pages.
  if (c.req.method === "POST") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.text("bad origin", 403);
  }
  await next();
});

app.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/login");
});

app.get("/", async (c) => {
  const today = localDate(nowSec());
  const googleConnected = await isGoogleConnected(c.env);
  const [snap, rec] = await Promise.all([buildSnapshot(c.env, today, googleConnected), latestRecommendation(c.env, today)]);
  return c.html(dashboardPage(snap, rec, { googleConnected, flash: c.req.query("msg") }));
});

app.get("/history", async (c) => c.html(historyPage(await recommendationHistory(c.env, 60))));

app.get("/settings", async (c) => {
  const [ctx, googleConnected, jobs, payloads] = await Promise.all([
    getSetting(c.env, "training_context"),
    isGoogleConnected(c.env),
    c.env.DB.prepare("SELECT kind, at, ok, message FROM job_log ORDER BY id DESC LIMIT 25").all<{ kind: string; at: string; ok: number; message: string }>(),
    c.env.DB.prepare("SELECT id, received_at, bytes, status, summary, error FROM raw_payloads ORDER BY id DESC LIMIT 15").all<{
      id: number; received_at: string; bytes: number; status: string; summary: string | null; error: string | null;
    }>(),
  ]);
  return c.html(
    settingsPage({
      context: ctx ?? DEFAULT_TRAINING_CONTEXT,
      isDefault: ctx == null,
      googleConnected,
      origin: new URL(c.req.url).origin,
      jobs: jobs.results,
      payloads: payloads.results,
      saved: c.req.query("saved") === "1",
    }),
  );
});

app.post("/settings/context", async (c) => {
  const form = await c.req.parseBody();
  const text = String(form.context ?? "").slice(0, 8000).trim();
  if (text) await setSetting(c.env, "training_context", text);
  return c.redirect("/settings?saved=1");
});

app.post("/actions/sync", async (c) => {
  let msg: string;
  try {
    const r = await syncCalendar(c.env);
    msg = r ? `Calendar synced: ${r.events} events (${r.tennis} tennis).` : "Calendar not connected.";
  } catch (e) {
    msg = `Calendar sync failed: ${e instanceof Error ? e.message : e}`;
    await logJob(c.env, "calendar", false, msg);
  }
  const today = localDate(nowSec());
  await recomputeDays(c.env, [today]);
  await storeReadiness(c.env, await buildSnapshot(c.env, today, await isGoogleConnected(c.env)));
  return c.redirect(`/?msg=${encodeURIComponent(msg)}`);
});

app.post("/actions/recommendations", async (c) => {
  try {
    await maybeGenerateRecommendations(c.env, true);
    return c.redirect("/");
  } catch (e) {
    return c.redirect(`/?msg=${encodeURIComponent(`Could not generate recommendations: ${e instanceof Error ? e.message : e}`)}`);
  }
});

// ---------- Google OAuth ----------
const redirectUri = (c: Context<App>) => `${new URL(c.req.url).origin}/auth/google/callback`;

app.get("/auth/google/start", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.text("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.", 500);
  return c.redirect(googleAuthUrl(c.env, redirectUri(c), await makeState(c.env)));
});

app.get("/auth/google/callback", async (c) => {
  if (!(await verifyState(c.env, c.req.query("state")))) return c.text("Invalid or expired state, start again from Settings.", 400);
  const err = c.req.query("error");
  if (err) return c.redirect(`/?msg=${encodeURIComponent(`Google sign-in cancelled: ${err}`)}`);
  try {
    await exchangeCode(c.env, c.req.query("code") ?? "", redirectUri(c));
    const r = await syncCalendar(c.env);
    return c.redirect(`/?msg=${encodeURIComponent(`Google Calendar connected: ${r?.events ?? 0} events, ${r?.tennis ?? 0} tennis.`)}`);
  } catch (e) {
    return c.redirect(`/?msg=${encodeURIComponent(`Google connection failed: ${e instanceof Error ? e.message : e}`)}`);
  }
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduled(env));
  },
} satisfies ExportedHandler<Env>;
