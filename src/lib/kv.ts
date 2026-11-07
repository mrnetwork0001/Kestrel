/**
 * Minimal shared key-value store for serverless instances.
 * Upstash Redis over its REST API (plain fetch, no SDK) when configured via the Vercel Marketplace
 * integration (KV_REST_API_URL / KV_REST_API_TOKEN) or Upstash directly (UPSTASH_REDIS_REST_URL / _TOKEN).
 * Without those env vars it falls back to an in-process Map with expiry, so local dev just works.
 *
 * Reads never throw (KV errors are logged and degrade to "miss"); writes surface errors to callers.
 */

const PREFIX = "kestrel:";
const TIMEOUT_MS = 2_500;

type Cmd = (string | number)[];
type Reply = { result?: unknown; error?: string };

function creds(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export function kvMode(): "upstash" | "memory" {
  return creds() ? "upstash" : "memory";
}

const k = (key: string) => PREFIX + key;

/** Runs commands in one round-trip (`/pipeline` when more than one). Throws on transport or command errors. */
async function upstash(cmds: Cmd[]): Promise<unknown[]> {
  const c = creds()!;
  const single = cmds.length === 1;
  const res = await fetch(single ? c.url : `${c.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(single ? cmds[0] : cmds),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Reply | Reply[] | null;
  if (!body) throw new Error(`KV HTTP ${res.status}`);
  const replies = Array.isArray(body) ? body : [body];
  const failed = replies.find((r) => r.error);
  if (failed || !res.ok) throw new Error(`KV ${failed?.error ?? `HTTP ${res.status}`}`);
  return replies.map((r) => r.result);
}

/* ---------------- in-process fallback ---------------- */

type MemVal = string | Map<string, string> | Set<string>;
// Pinned on globalThis so every route bundle (and dev hot reloads) in this process share one store.
const g = globalThis as typeof globalThis & { __kestrelKv?: Map<string, { v: MemVal; exp: number | null }> };
const mem = (g.__kestrelKv ??= new Map());

function memGet(key: string) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp !== null && e.exp <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return e;
}

function memPut(key: string, v: MemVal, exSec?: number, keepTtl = false) {
  const exp = exSec ? Date.now() + exSec * 1000 : keepTtl ? (memGet(key)?.exp ?? null) : null;
  mem.set(key, { v, exp });
  if (mem.size > 10_000) {
    const now = Date.now();
    for (const [mk, e] of mem) if (e.exp !== null && e.exp <= now) mem.delete(mk);
    if (mem.size > 10_000) mem.clear();
  }
}

/** Process-local fixed-window counter. Used in memory mode and as the fail-open fallback for rate limiting. */
export function localIncrWithExpiry(key: string, windowSec: number, by = 1): number {
  const e = memGet(k(key));
  const next = (typeof e?.v === "string" ? Number(e.v) : 0) + by;
  if (e) e.v = String(next);
  else memPut(k(key), String(next), windowSec);
  return next;
}

function logRead(op: string, key: string, e: unknown) {
  console.warn(`[kv] ${op} ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
}

/* ---------------- strings ---------------- */

export async function kvGet(key: string): Promise<string | null> {
  if (!creds()) {
    const e = memGet(k(key));
    return typeof e?.v === "string" ? e.v : null;
  }
  try {
    const [r] = await upstash([["GET", k(key)]]);
    return typeof r === "string" ? r : null;
  } catch (e) {
    logRead("GET", key, e);
    return null;
  }
}

/** SET with optional EX seconds and NX. Returns false when NX prevented the write (key already existed). */
export async function kvSet(key: string, value: string, opts: { ex?: number; nx?: boolean } = {}): Promise<boolean> {
  const ex = opts.ex && opts.ex > 0 ? Math.ceil(opts.ex) : undefined;
  if (!creds()) {
    if (opts.nx && memGet(k(key))) return false;
    memPut(k(key), value, ex);
    return true;
  }
  const cmd: Cmd = ["SET", k(key), value];
  if (ex) cmd.push("EX", ex);
  if (opts.nx) cmd.push("NX");
  const [r] = await upstash([cmd]);
  return r === "OK";
}

export async function kvDel(...keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  if (!creds()) return keys.filter((key) => memGet(k(key)) && mem.delete(k(key))).length;
  const [r] = await upstash([["DEL", ...keys.map(k)]]);
  return Number(r ?? 0);
}

export async function kvExpire(key: string, seconds: number): Promise<boolean> {
  if (!creds()) {
    const e = memGet(k(key));
    if (!e) return false;
    e.exp = Date.now() + seconds * 1000;
    return true;
  }
  const [r] = await upstash([["EXPIRE", k(key), Math.ceil(seconds)]]);
  return r === 1;
}

/** Fixed-window counter: INCRBY then EXPIRE NX (TTL set only on the window's first hit), one round-trip. */
export async function kvIncrWithExpiry(key: string, windowSec: number, by = 1): Promise<number> {
  if (!creds()) return localIncrWithExpiry(key, windowSec, by);
  const [count] = await upstash([
    ["INCRBY", k(key), by],
    ["EXPIRE", k(key), Math.ceil(windowSec), "NX"],
  ]);
  return Number(count);
}

/* ---------------- JSON ---------------- */

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Throws (without writing) if `value` is not plain JSON — e.g. it contains a bigint. */
export async function kvSetJson(key: string, value: unknown, opts: { ex?: number; nx?: boolean } = {}): Promise<boolean> {
  const raw = JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") throw new TypeError(`kvSetJson(${key}): bigint values must be serialized to decimal strings first`);
    return v;
  });
  if (raw === undefined) throw new TypeError(`kvSetJson(${key}): value is not JSON-serializable`);
  return kvSet(key, raw, opts);
}

/* ---------------- hashes ---------------- */

export async function kvHSet(key: string, fields: Record<string, string>): Promise<number> {
  const entries = Object.entries(fields);
  if (!entries.length) return 0;
  if (!creds()) {
    const e = memGet(k(key));
    const h = e?.v instanceof Map ? e.v : new Map<string, string>();
    const added = entries.filter(([f]) => !h.has(f)).length;
    for (const [f, v] of entries) h.set(f, v);
    if (!e || !(e.v instanceof Map)) memPut(k(key), h, undefined, true);
    return added;
  }
  const [r] = await upstash([["HSET", k(key), ...entries.flat()]]);
  return Number(r ?? 0);
}

export async function kvHGetAll(key: string): Promise<Record<string, string>> {
  if (!creds()) {
    const e = memGet(k(key));
    return e?.v instanceof Map ? Object.fromEntries(e.v) : {};
  }
  try {
    const [r] = await upstash([["HGETALL", k(key)]]);
    const flat = Array.isArray(r) ? (r as string[]) : [];
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  } catch (e) {
    logRead("HGETALL", key, e);
    return {};
  }
}

export async function kvHDel(key: string, ...fields: string[]): Promise<number> {
  if (!fields.length) return 0;
  if (!creds()) {
    const e = memGet(k(key));
    return e?.v instanceof Map ? fields.filter((f) => (e.v as Map<string, string>).delete(f)).length : 0;
  }
  const [r] = await upstash([["HDEL", k(key), ...fields]]);
  return Number(r ?? 0);
}

/* ---------------- sets ---------------- */

export async function kvSAdd(key: string, ...members: string[]): Promise<number> {
  if (!members.length) return 0;
  if (!creds()) {
    const e = memGet(k(key));
    const s = e?.v instanceof Set ? e.v : new Set<string>();
    const added = members.filter((m) => !s.has(m) && s.add(m)).length;
    if (!e || !(e.v instanceof Set)) memPut(k(key), s, undefined, true);
    return added;
  }
  const [r] = await upstash([["SADD", k(key), ...members]]);
  return Number(r ?? 0);
}

export async function kvSMembers(key: string): Promise<string[]> {
  if (!creds()) {
    const e = memGet(k(key));
    return e?.v instanceof Set ? [...e.v] : [];
  }
  try {
    const [r] = await upstash([["SMEMBERS", k(key)]]);
    return Array.isArray(r) ? (r as string[]) : [];
  } catch (e) {
    logRead("SMEMBERS", key, e);
    return [];
  }
}

export async function kvSRem(key: string, ...members: string[]): Promise<number> {
  if (!members.length) return 0;
  if (!creds()) {
    const e = memGet(k(key));
    return e?.v instanceof Set ? members.filter((m) => (e.v as Set<string>).delete(m)).length : 0;
  }
  const [r] = await upstash([["SREM", k(key), ...members]]);
  return Number(r ?? 0);
}
