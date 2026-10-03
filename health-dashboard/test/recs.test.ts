import { afterEach, describe, expect, it, vi } from "vitest";
import { generateRecommendations, buildPromptData } from "../src/recs/claude";
import type { Snapshot } from "../src/metrics/snapshot";
import type { Env } from "../src/env";
import { computeReadiness } from "../src/metrics/readiness";

const snap: Snapshot = {
  today: "2026-10-03",
  days: [{ date: "2026-10-03", sleep_h: 6, in_bed_h: 6.5, deep_h: 1, core_h: 3.6, rem_h: 1.4, awake_h: 0.3, bed_ts: null, wake_ts: null, resting_hr: 58, hrv: 42, hrv_n: 2, spo2: 96, spo2_min: 94, steps: null, active_kcal: null }],
  baselines: { hrv7: 47, hrv28: 50, hrvDays: 20, rhr7: 56, rhr28: 55, rhrDays: 20, sleep7: 6.8, sleep28: 7, sleepDays: 20 },
  readiness: computeReadiness({ hrvToday: 42, hrvBaseline28: 50, hrvBaselineDays: 20, rhrToday: 58, rhrBaseline28: 55, rhrBaselineDays: 20, sleepLastNight: 6, sleepAvg28: 7, sleepBaselineDays: 20, acwr: 1.1, busyHoursToday: 4, busyHoursTomorrow: 2, fullDayToday: false }),
  readinessHistory: [{ date: "2026-10-03", score: 50 }],
  sessions: [], load: { acute: 1500, chronic: 1400, acwr: 1.07, daysOfHistory: 40 }, weekly: [],
  busyness: [{ date: "2026-10-03", hours: 4, fullDay: false, heavy: false, events: 2, tennis: 1 }],
  upcoming: [{ id: "p:1", summary: "Court 2 (covered)", location: "", start_ts: 1791021600, end_ts: 1791027000, all_day: 0, start_date: "2026-10-03", end_date: "2026-10-03", busy: 1, is_tennis: 1 }],
  sleepConsistency: { bedSdMin: 20, wakeSdMin: 30, nights: 7 },
  freshness: { lastIngest: null, lastCalendar: null, lastHealthSample: null },
};

function fakeEnv() {
  const writes: unknown[][] = [];
  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => (sql.includes("FROM settings") ? { value: "Test training context." } : null),
      run: async () => { writes.push([sql, ...args]); return {}; },
    }),
  });
  return { env: { DB: { prepare: stmt }, CLAUDE_MODEL: "claude-opus-5-5", ANTHROPIC_API_KEY: "test" } as unknown as Env, writes };
}

afterEach(() => vi.unstubAllGlobals());

describe("recommendations", () => {
  it("prompt data includes context, readiness limiter and tennis bookings", () => {
    const d = buildPromptData(snap, "ctx");
    expect(d.training_context).toBe("ctx");
    expect(d.readiness.limiting_factor).toMatch(/^HRV/);
    expect(d.calendar_next_7_days[0].events[0]).toMatch(/\[TENNIS\]/);
    expect(d.free_slots.today.length).toBeGreaterThan(0);
  });

  it("calls the Messages API with structured output + fallbacks and stores the parsed result", async () => {
    const content = {
      headline: "Modified day: skip serves, keep it short",
      day_type: "modified",
      best_slot: "16:00–17:30 (tennis, baseline only)",
      sleep_target: "Lights out 22:15, aim 7h45",
      recommendations: [
        { category: "training", title: "Baseline rallies only", detail: "No serves or smashes." },
        { category: "sleep", title: "Earlier night", detail: "In bed by 22:15." },
        { category: "recovery", title: "Mobility 15 min", detail: "Hips and thoracic." },
      ],
      caution: "",
    };
    let body: Record<string, unknown> = {};
    let headers: Headers = new Headers();
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify(content) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { env, writes } = fakeEnv();
    const out = await generateRecommendations(env, snap);
    expect(out.day_type).toBe("modified");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(JSON.stringify(body.messages)).toContain("Test training context.");
    expect(writes.some((w) => String(w[0]).startsWith("INSERT INTO recommendations"))).toBe(true);
  });
});
