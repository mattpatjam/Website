export interface Env {
  DB: D1Database;
  CLAUDE_MODEL: string;
  INGEST_TOKEN: string;
  DASHBOARD_PASSWORD: string;
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
}

export async function logJob(env: Env, kind: string, ok: boolean, message: string) {
  await env.DB.prepare("INSERT INTO job_log (kind, at, ok, message) VALUES (?, ?, ?, ?)")
    .bind(kind, new Date().toISOString(), ok ? 1 : 0, message.slice(0, 2000))
    .run();
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(key, value, new Date().toISOString())
    .run();
}
