import { config } from "./config";
import type { Env } from "./env";
import { logJob } from "./env";
import { isGoogleConnected, syncCalendar } from "./calendar/google";
import { addDays, dateRange, localDate, localTimeOn, nowSec } from "./lib/time";
import { recomputeDays } from "./metrics/daily";
import { buildSnapshot, storeReadiness } from "./metrics/snapshot";
import { generateRecommendations, latestRecommendation } from "./recs/claude";

/** Generate today's recommendations once, after 06:30, ideally once last night's sleep is in. */
export async function maybeGenerateRecommendations(env: Env, force = false): Promise<string> {
  const now = nowSec();
  const today = localDate(now);
  if (!force) {
    if (now < localTimeOn(today, config.morningRunAt)) return "before morning run time";
    if (await latestRecommendation(env, today)) return "already generated today";
  }
  const connected = await isGoogleConnected(env);
  const snap = await buildSnapshot(env, today, connected);
  const haveSleep = snap.days[snap.days.length - 1]?.sleep_h != null;
  if (!force && !haveSleep && now < localTimeOn(today, config.morningRunLatest)) return "waiting for last night's sleep data";
  try {
    await generateRecommendations(env, snap);
    return "generated";
  } catch (e) {
    await logJob(env, "recs", false, String(e instanceof Error ? e.message : e));
    throw e;
  }
}

/** Runs every 30 minutes from the cron trigger. */
export async function scheduled(env: Env) {
  const results: string[] = [];
  const now = nowSec();
  const today = localDate(now);

  // 1. Calendar, at most ~hourly.
  try {
    const last = await env.DB.prepare("SELECT at FROM job_log WHERE kind = 'calendar' AND ok = 1 ORDER BY id DESC LIMIT 1").first<{ at: string }>();
    if (!last || Date.now() - Date.parse(last.at) > 55 * 60 * 1000) {
      const r = await syncCalendar(env);
      results.push(r ? `calendar: ${r.events} events` : "calendar: not connected");
    }
  } catch (e) {
    await logJob(env, "calendar", false, String(e instanceof Error ? e.message : e));
    results.push(`calendar failed: ${e}`);
  }

  // 2. Recompute the last few days (late-arriving data) and store readiness.
  try {
    await recomputeDays(env, dateRange(addDays(today, -3), today));
    const snap = await buildSnapshot(env, today, await isGoogleConnected(env));
    await storeReadiness(env, snap);
  } catch (e) {
    await logJob(env, "recompute", false, String(e instanceof Error ? e.message : e));
  }

  // 3. Morning recommendations.
  try {
    results.push(`recs: ${await maybeGenerateRecommendations(env)}`);
  } catch (e) {
    results.push(`recs failed: ${e}`);
  }
  console.log(results.join(" | "));
}
