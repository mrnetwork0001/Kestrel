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

/** Sorted set in memory mode (wrapped so it is never mistaken for a hash `Map`). */
type MemZSet = { z: Map<string, number> };
type MemVal = string | Map<string, string> | Set<string> | string[] | MemZSet;
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

/* ---------------- batches: pipeline / MULTI (pager store) ---------------- */

/** True when production would silently run on per-instance memory. Pager routes answer 503 in that case. */
export function kvMissingInProd(): boolean {
  return kvMode() === "memory" && process.env.VERCEL_ENV === "production";
}

/**
 * One structured command. Keys are logical (the `kestrel:` prefix is added here), so callers never build raw
 * Redis commands and memory mode can emulate every op exactly.
 */
export type KvOp =
  | { op: "get"; key: string }
  | { op: "getdel"; key: string }
  | { op: "set"; key: string; value: string; ex?: number; px?: number; nx?: boolean; xx?: boolean }
  | { op: "del"; keys: string[] }
  /** Compare-and-delete: DEL only if the current value equals `value` (lock release). */
  | { op: "delifeq"; key: string; value: string }
  | { op: "incr"; key: string; by?: number }
  | { op: "expire"; key: string; seconds: number }
  | { op: "hget"; key: string; field: string }
  | { op: "hmget"; key: string; fields: string[] }
  | { op: "hset"; key: string; fields: Record<string, string> }
  | { op: "hdel"; key: string; fields: string[] }
  | { op: "hgetall"; key: string }
  | { op: "hlen"; key: string }
  | { op: "lpush"; key: string; values: string[] }
  | { op: "ltrim"; key: string; start: number; stop: number }
  | { op: "lrange"; key: string; start: number; stop: number }
  | { op: "zadd"; key: string; members: { score: number; member: string }[] }
  | { op: "zrem"; key: string; members: string[] }
  | { op: "zrangebyscore"; key: string; min: number | "-inf"; max: number | "+inf"; limit?: number }
  | { op: "zscore"; key: string; member: string };

export type KvResult<O extends KvOp> = O["op"] extends "get" | "getdel" | "hget"
  ? string | null
  : O["op"] extends "set" | "expire" | "ltrim"
    ? boolean
    : O["op"] extends "hmget"
      ? (string | null)[]
      : O["op"] extends "hgetall"
        ? Record<string, string>
        : O["op"] extends "lrange" | "zrangebyscore"
          ? string[]
          : O["op"] extends "zscore"
            ? number | null
            : number;

type KvResults<T extends readonly KvOp[]> = { -readonly [I in keyof T]: KvResult<T[I]> };

const DEL_IF_EQ = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
const BATCH_TIMEOUT_MS = 8_000;

/** Ops with nothing to do (e.g. HMGET of zero fields) are answered locally instead of sending an invalid command. */
function emptyResult(o: KvOp): unknown | undefined {
  switch (o.op) {
    case "hmget": return o.fields.length ? undefined : [];
    case "hset": return Object.keys(o.fields).length ? undefined : 0;
    case "hdel": return o.fields.length ? undefined : 0;
    case "del": return o.keys.length ? undefined : 0;
    case "lpush": return o.values.length ? undefined : 0;
    case "zadd": return o.members.length ? undefined : 0;
    case "zrem": return o.members.length ? undefined : 0;
    default: return undefined;
  }
}

/** Upstash REST takes every argument as a string. */
function toCmd(o: KvOp): string[] {
  return rawCmd(o).map(String);
}

function rawCmd(o: KvOp): Cmd {
  switch (o.op) {
    case "get": return ["GET", k(o.key)];
    case "getdel": return ["GETDEL", k(o.key)];
    case "set": {
      const c: Cmd = ["SET", k(o.key), o.value];
      if (o.px && o.px > 0) c.push("PX", Math.ceil(o.px));
      else if (o.ex && o.ex > 0) c.push("EX", Math.ceil(o.ex));
      if (o.nx) c.push("NX");
      else if (o.xx) c.push("XX");
      return c;
    }
    case "del": return ["DEL", ...o.keys.map(k)];
    case "delifeq": return ["EVAL", DEL_IF_EQ, 1, k(o.key), o.value];
    case "incr": return ["INCRBY", k(o.key), o.by ?? 1];
    case "expire": return ["EXPIRE", k(o.key), Math.ceil(o.seconds)];
    case "hget": return ["HGET", k(o.key), o.field];
    case "hmget": return ["HMGET", k(o.key), ...o.fields];
    case "hset": return ["HSET", k(o.key), ...Object.entries(o.fields).flat()];
    case "hdel": return ["HDEL", k(o.key), ...o.fields];
    case "hgetall": return ["HGETALL", k(o.key)];
    case "hlen": return ["HLEN", k(o.key)];
    case "lpush": return ["LPUSH", k(o.key), ...o.values];
    case "ltrim": return ["LTRIM", k(o.key), o.start, o.stop];
    case "lrange": return ["LRANGE", k(o.key), o.start, o.stop];
    case "zadd": return ["ZADD", k(o.key), ...o.members.flatMap((m) => [m.score, m.member])];
    case "zrem": return ["ZREM", k(o.key), ...o.members];
    case "zrangebyscore": {
      const c: Cmd = ["ZRANGEBYSCORE", k(o.key), o.min, o.max];
      if (o.limit !== undefined) c.push("LIMIT", 0, o.limit);
      return c;
    }
    case "zscore": return ["ZSCORE", k(o.key), o.member];
  }
}

/** Upstash REST replies → the normalized shapes of `KvResult`. */
function fromReply(o: KvOp, r: unknown): unknown {
  switch (o.op) {
    case "get": case "getdel": case "hget": return typeof r === "string" ? r : null;
    case "set": return r === "OK";
    case "expire": return r === 1;
    case "ltrim": return r === "OK";
    case "hmget": return Array.isArray(r) ? r.map((x) => (typeof x === "string" ? x : null)) : o.fields.map(() => null);
    case "hgetall": {
      const flat = Array.isArray(r) ? (r as string[]) : [];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    }
    case "lrange": case "zrangebyscore": return Array.isArray(r) ? (r as string[]) : [];
    case "zscore": return r === null || r === undefined ? null : Number(r);
    default: return Number(r ?? 0);
  }
}

/** Normalizes Redis list indexes (negative = from the end) to an inclusive [lo, hi] slice range. */
function listRange(len: number, start: number, stop: number): [number, number] {
  const lo = Math.max(0, start < 0 ? len + start : start);
  const hi = Math.min(len - 1, stop < 0 ? len + stop : stop);
  return [lo, hi];
}

/** In-memory emulation of one op (same result shapes as `fromReply`). Synchronous, so a whole batch is atomic. */
function memExec(o: KvOp): unknown {
  switch (o.op) {
    case "get": {
      const e = memGet(k(o.key));
      return typeof e?.v === "string" ? e.v : null;
    }
    case "getdel": {
      const e = memGet(k(o.key));
      if (typeof e?.v !== "string") return null;
      mem.delete(k(o.key));
      return e.v;
    }
    case "set": {
      const exists = !!memGet(k(o.key));
      if ((o.nx && exists) || (o.xx && !exists)) return false;
      const exSec = o.px && o.px > 0 ? o.px / 1000 : o.ex && o.ex > 0 ? Math.ceil(o.ex) : undefined;
      memPut(k(o.key), o.value, exSec);
      return true;
    }
    case "del": return o.keys.filter((key) => memGet(k(key)) && mem.delete(k(key))).length;
    case "delifeq": {
      const e = memGet(k(o.key));
      if (typeof e?.v === "string" && e.v === o.value) {
        mem.delete(k(o.key));
        return 1;
      }
      return 0;
    }
    case "incr": {
      const e = memGet(k(o.key));
      const next = (typeof e?.v === "string" ? Number(e.v) : 0) + (o.by ?? 1);
      if (e) e.v = String(next);
      else memPut(k(o.key), String(next));
      return next;
    }
    case "expire": {
      const e = memGet(k(o.key));
      if (!e) return false;
      e.exp = Date.now() + o.seconds * 1000;
      return true;
    }
    case "hget": {
      const e = memGet(k(o.key));
      return e?.v instanceof Map ? (e.v.get(o.field) ?? null) : null;
    }
    case "hmget": {
      const e = memGet(k(o.key));
      return o.fields.map((f) => (e?.v instanceof Map ? (e.v.get(f) ?? null) : null));
    }
    case "hset": {
      const e = memGet(k(o.key));
      const h = e?.v instanceof Map ? e.v : new Map<string, string>();
      const entries = Object.entries(o.fields);
      const added = entries.filter(([f]) => !h.has(f)).length;
      for (const [f, v] of entries) h.set(f, v);
      if (!e || !(e.v instanceof Map)) memPut(k(o.key), h, undefined, true);
      return added;
    }
    case "hdel": {
      const e = memGet(k(o.key));
      return e?.v instanceof Map ? o.fields.filter((f) => (e.v as Map<string, string>).delete(f)).length : 0;
    }
    case "hgetall": {
      const e = memGet(k(o.key));
      return e?.v instanceof Map ? Object.fromEntries(e.v) : {};
    }
    case "hlen": {
      const e = memGet(k(o.key));
      return e?.v instanceof Map ? e.v.size : 0;
    }
    case "lpush": {
      const e = memGet(k(o.key));
      const list = Array.isArray(e?.v) ? (e.v as string[]) : [];
      for (const v of o.values) list.unshift(v);
      if (!e || !Array.isArray(e.v)) memPut(k(o.key), list, undefined, true);
      return list.length;
    }
    case "ltrim": {
      const e = memGet(k(o.key));
      if (!e || !Array.isArray(e.v)) return true;
      const [lo, hi] = listRange(e.v.length, o.start, o.stop);
      e.v = lo > hi ? [] : e.v.slice(lo, hi + 1);
      return true;
    }
    case "lrange": {
      const e = memGet(k(o.key));
      if (!e || !Array.isArray(e.v)) return [];
      const [lo, hi] = listRange(e.v.length, o.start, o.stop);
      return lo > hi ? [] : e.v.slice(lo, hi + 1);
    }
    case "zadd": {
      const e = memGet(k(o.key));
      const isZ = !!e && typeof e.v === "object" && "z" in e.v;
      const zs = isZ ? (e!.v as MemZSet) : { z: new Map<string, number>() };
      const added = o.members.filter((m) => !zs.z.has(m.member)).length;
      for (const m of o.members) zs.z.set(m.member, m.score);
      if (!isZ) memPut(k(o.key), zs, undefined, true);
      return added;
    }
    case "zrem": {
      const e = memGet(k(o.key));
      if (!e || typeof e.v !== "object" || !("z" in e.v)) return 0;
      const zs = e.v as MemZSet;
      return o.members.filter((m) => zs.z.delete(m)).length;
    }
    case "zrangebyscore": {
      const e = memGet(k(o.key));
      if (!e || typeof e.v !== "object" || !("z" in e.v)) return [];
      const min = o.min === "-inf" ? -Infinity : o.min;
      const max = o.max === "+inf" ? Infinity : o.max;
      const out = [...(e.v as MemZSet).z.entries()]
        .filter(([, s]) => s >= min && s <= max)
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .map(([m]) => m);
      return o.limit !== undefined ? out.slice(0, o.limit) : out;
    }
    case "zscore": {
      const e = memGet(k(o.key));
      if (!e || typeof e.v !== "object" || !("z" in e.v)) return null;
      return (e.v as MemZSet).z.get(o.member) ?? null;
    }
  }
}

async function upstashBatch(cmds: Cmd[], atomic: boolean): Promise<unknown[]> {
  const c = creds()!;
  const res = await fetch(`${c.url}${atomic ? "/multi-exec" : "/pipeline"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
    cache: "no-store",
    signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Reply | Reply[] | null;
  if (!body) throw new Error(`KV HTTP ${res.status}`);
  if (!Array.isArray(body)) throw new Error(`KV ${atomic ? "transaction discarded" : "pipeline failed"}: ${body.error ?? `HTTP ${res.status}`}`);
  const failed = body.find((r) => r?.error);
  if (failed) throw new Error(`KV ${failed.error}`);
  if (!res.ok) throw new Error(`KV HTTP ${res.status}`);
  return body.map((r) => r?.result);
}

/**
 * Runs several ops in ONE round-trip: Upstash `/pipeline`, or `/multi-exec` when `atomic` (all-or-nothing).
 * Memory mode executes them synchronously (inherently atomic). Unlike the single-key helpers above, this
 * THROWS on any transport or command error, so callers never mistake a failed read for an empty store.
 */
export async function kvBatch<const T extends readonly KvOp[]>(ops: T, opts: { atomic?: boolean } = {}): Promise<KvResults<T>> {
  if (!ops.length) return [] as unknown as KvResults<T>;
  if (!creds()) return ops.map((o) => emptyResult(o) ?? memExec(o)) as KvResults<T>;
  const out: unknown[] = ops.map((o) => emptyResult(o));
  const send = ops.map((o, i) => ({ o, i })).filter(({ i }) => out[i] === undefined);
  if (send.length) {
    const replies = send.length === 1 && !opts.atomic ? await upstash([toCmd(send[0].o)]) : await upstashBatch(send.map(({ o }) => toCmd(o)), !!opts.atomic);
    send.forEach(({ o, i }, j) => (out[i] = fromReply(o, replies[j])));
  }
  return out as KvResults<T>;
}

/** Single structured op; throws on error (see `kvBatch`). */
export async function kvOne<O extends KvOp>(op: O): Promise<KvResult<O>> {
  const [r] = await kvBatch([op] as const);
  return r as KvResult<O>;
}
