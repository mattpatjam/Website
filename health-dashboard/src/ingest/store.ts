import type { Env } from "../env";
import type { ParsedPayload } from "./parse";
import { nightDateFor } from "../lib/time";

const CHUNK_BYTES = 1_500_000; // D1 caps a row at ~2 MB
const BATCH = 80; // statements per D1 batch

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Store the raw body. Returns { id, duplicate }. A byte-identical re-send is
 * detected by hash and skipped entirely.
 */
export async function storeRaw(env: Env, body: Uint8Array): Promise<{ id: number; duplicate: boolean }> {
  const hash = await sha256Hex(body);
  const existing = await env.DB.prepare("SELECT id FROM raw_payloads WHERE sha256 = ?").bind(hash).first<{ id: number }>();
  if (existing) return { id: existing.id, duplicate: true };

  const gz = await gzip(body);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < gz.length; i += CHUNK_BYTES) chunks.push(gz.subarray(i, i + CHUNK_BYTES));

  const row = await env.DB.prepare(
    "INSERT INTO raw_payloads (sha256, received_at, bytes, chunks, status) VALUES (?, ?, ?, ?, 'pending') RETURNING id",
  )
    .bind(hash, new Date().toISOString(), body.length, chunks.length)
    .first<{ id: number }>();
  const id = row!.id;
  for (let i = 0; i < chunks.length; i++) {
    await env.DB.prepare("INSERT INTO raw_payload_chunks (payload_id, idx, data) VALUES (?, ?, ?)")
      .bind(id, i, chunks[i])
      .run();
  }
  return { id, duplicate: false };
}

export async function markRaw(env: Env, id: number, status: "parsed" | "error", summary: unknown, error?: string) {
  await env.DB.prepare("UPDATE raw_payloads SET status = ?, summary = ?, error = ? WHERE id = ?")
    .bind(status, JSON.stringify(summary), error ?? null, id)
    .run();
}

async function runBatched(env: Env, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += BATCH) await env.DB.batch(stmts.slice(i, i + BATCH));
}

/**
 * Upsert parsed records. Every table has a natural key, so re-sent or
 * overlapping data replaces rather than duplicates. Returns the set of local
 * dates whose daily metrics need recomputing.
 */
export async function storeParsed(env: Env, p: ParsedPayload): Promise<Set<string>> {
  const db = env.DB;
  const touched = new Set<string>();
  const stmts: D1PreparedStatement[] = [];

  const sampleStmt = db.prepare(
    `INSERT INTO samples (metric, ts, local_date, source, value, value_min, value_max)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (metric, ts, source) DO UPDATE SET
       value = excluded.value, value_min = excluded.value_min, value_max = excluded.value_max
     WHERE samples.value IS NOT excluded.value
        OR samples.value_min IS NOT excluded.value_min
        OR samples.value_max IS NOT excluded.value_max`,
  );
  for (const s of p.samples) {
    stmts.push(sampleStmt.bind(s.metric, s.ts, s.local_date, s.source, s.value, s.value_min, s.value_max));
    touched.add(s.local_date);
  }

  const sumStmt = db.prepare(
    `INSERT INTO sleep_summaries (night_date, source, sleep_start_ts, sleep_end_ts, in_bed_start_ts, in_bed_end_ts,
       asleep_h, in_bed_h, deep_h, core_h, rem_h, awake_h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (night_date, source) DO UPDATE SET
       sleep_start_ts = excluded.sleep_start_ts, sleep_end_ts = excluded.sleep_end_ts,
       in_bed_start_ts = excluded.in_bed_start_ts, in_bed_end_ts = excluded.in_bed_end_ts,
       asleep_h = excluded.asleep_h, in_bed_h = excluded.in_bed_h, deep_h = excluded.deep_h,
       core_h = excluded.core_h, rem_h = excluded.rem_h, awake_h = excluded.awake_h`,
  );
  for (const s of p.sleepSummaries) {
    stmts.push(
      sumStmt.bind(
        s.night_date, s.source, s.sleep_start_ts, s.sleep_end_ts, s.in_bed_start_ts, s.in_bed_end_ts,
        s.asleep_h, s.in_bed_h, s.deep_h, s.core_h, s.rem_h, s.awake_h,
      ),
    );
    touched.add(s.night_date);
  }

  const segStmt = db.prepare(
    `INSERT INTO sleep_segments (start_ts, end_ts, stage, source, night_date) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (start_ts, stage, source) DO UPDATE SET end_ts = excluded.end_ts, night_date = excluded.night_date
     WHERE sleep_segments.end_ts IS NOT excluded.end_ts`,
  );
  for (const s of p.sleepSegments) {
    stmts.push(segStmt.bind(s.start_ts, s.end_ts, s.stage, s.source, s.night_date));
    touched.add(s.night_date);
  }

  const wStmt = db.prepare(
    `INSERT INTO workouts (id, name, start_ts, end_ts, local_date, duration_min, active_kcal, avg_hr, max_hr, distance_km, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, start_ts = excluded.start_ts, end_ts = excluded.end_ts, local_date = excluded.local_date,
       duration_min = excluded.duration_min, active_kcal = excluded.active_kcal, avg_hr = excluded.avg_hr,
       max_hr = excluded.max_hr, distance_km = excluded.distance_km, source = excluded.source`,
  );
  for (const w of p.workouts) {
    stmts.push(
      wStmt.bind(w.id, w.name, w.start_ts, w.end_ts, w.local_date, w.duration_min, w.active_kcal, w.avg_hr, w.max_hr, w.distance_km, w.source),
    );
    touched.add(w.local_date);
  }

  await runBatched(env, stmts);
  // SpO2 overnight is attributed to the wake date, so the day after a sample may change too.
  for (const s of p.samples) if (s.metric === "spo2") touched.add(nightDateFor(s.ts));
  return touched;
}
