/**
 * Single-user auth: one password (secret DASHBOARD_PASSWORD), an HMAC-signed
 * session cookie (secret SESSION_SECRET), and a lockout after repeated failures.
 */
import type { Env } from "../env";
import { nowSec } from "./time";

export const SESSION_COOKIE = "hd_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 8;
const WINDOW_SEC = 15 * 60;

const enc = new TextEncoder();

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string compare (compares HMACs so lengths never leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const k = "compare";
  const [x, y] = await Promise.all([hmac(k, a), hmac(k, b)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function makeSession(env: Env): Promise<{ value: string; maxAge: number }> {
  const exp = nowSec() + SESSION_DAYS * 86400;
  const payload = `v1.${exp}`;
  return { value: `${payload}.${await hmac(env.SESSION_SECRET, payload)}`, maxAge: SESSION_DAYS * 86400 };
}

export async function verifySession(env: Env, cookie: string | undefined): Promise<boolean> {
  if (!cookie || !env.SESSION_SECRET) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < nowSec()) return false;
  return safeEqual(parts[2], await hmac(env.SESSION_SECRET, `${parts[0]}.${parts[1]}`));
}

export async function isLockedOut(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND at > ?").bind(nowSec() - WINDOW_SEC).first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordAttempt(env: Env, ok: boolean) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO login_attempts (at, ok) VALUES (?, ?)").bind(nowSec(), ok ? 1 : 0),
    env.DB.prepare("DELETE FROM login_attempts WHERE at < ?").bind(nowSec() - 86400),
  ]);
}

/** Signed, short-lived OAuth state value (CSRF protection for the Google callback). */
export async function makeState(env: Env): Promise<string> {
  const payload = `${nowSec() + 600}.${crypto.randomUUID()}`;
  return `${payload}.${await hmac(env.SESSION_SECRET, `state.${payload}`)}`;
}

export async function verifyState(env: Env, state: string | undefined): Promise<boolean> {
  if (!state) return false;
  const i = state.lastIndexOf(".");
  const payload = state.slice(0, i);
  const exp = Number(payload.split(".")[0]);
  if (!Number.isFinite(exp) || exp < nowSec()) return false;
  return safeEqual(state.slice(i + 1), await hmac(env.SESSION_SECRET, `state.${payload}`));
}
