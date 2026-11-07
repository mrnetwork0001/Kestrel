/**
 * Night-Shift Pager persistence (spec sections 4.2 / 16). Every pager module reads and writes through here.
 *
 * Key space (logical keys; kv.ts adds the `kestrel:` prefix). All values are JSON strings.
 *   pager:desk               HASH   deskId → Desk
 *   pager:watch              HASH   watchId → Watch (config only)
 *   pager:cfgver             STRING INCR on any desk/watch change (lets warm instances skip reloading configs)
 *   pager:wstate             HASH   watchId → WatchState (tick-owned; config edits never touch it)
 *   pager:global             STRING PagerGlobal
 *   pager:outbox             HASH   deliveryId → OutboxItem (at-least-once delivery)
 *   pager:alerts:{deskId}    LIST   last 50 PagerAlert / digest entries (LPUSH + LTRIM)
 *   pager:wake               ZSET   deskId scored by wakeAt (ms)
 *   pager:sleep:{deskId}     STRING SleepSession
 *   pager:tglink:{token}     STRING EX 900, deskId (single-use)
 *   pager:tgchat:{chatId}    STRING deskId (reverse index)
 *   pager:tgoffset           STRING getUpdates offset (polling mode)
 *   pager:lock               STRING NX PX, tickId
 *   pager:desklock:{deskId}  STRING NX PX, short mutex for read-modify-write of a desk record
 *   pager:itemlock:{item}    STRING NX PX, per-item delivery lock ("outbox:<itemId>")
 *   pager:status             STRING last TickSummary
 *   pager:ticklog            LIST   last 50 TickSummary (hash-chained by the tick)
 *
 * Desk keys are never stored, only deskId = base64url(sha256(deskKey))[0:22].
 * Store functions THROW on KV errors (never treat a failed read as "empty"), so callers can answer 503.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { kvBatch, kvMode, kvOne, type KvOp } from "@/lib/kv";
import { CAMPAIGN_STATES } from "@/lib/engine/escrow";
import { fmtBps, fmtUnits, shortAddr } from "@/lib/format";
import { deskIdFromKey, newDeskKey } from "@/lib/pager/desk-key";
import { maxDesksTotal, maxWatchesPerDesk } from "@/lib/pager/limits";
import type {
  Desk,
  DeskPublic,
  DigestPayload,
  OutboxItem,
  PagerAlert,
  PagerGlobal,
  SleepPublic,
  SleepSession,
  TickSummary,
  Watch,
  WatchState,
  WatchView,
} from "@/lib/pager/types";

/* ---------------- keys ---------------- */

export const K = {
  desk: "pager:desk",
  watch: "pager:watch",
  cfgver: "pager:cfgver",
  wstate: "pager:wstate",
  global: "pager:global",
  outbox: "pager:outbox",
  alerts: (deskId: string) => `pager:alerts:${deskId}`,
  wake: "pager:wake",
  sleep: (deskId: string) => `pager:sleep:${deskId}`,
  tglink: (token: string) => `pager:tglink:${token}`,
  tgchat: (chatId: string) => `pager:tgchat:${chatId}`,
  tgoffset: "pager:tgoffset",
  lock: "pager:lock",
  deskLock: (deskId: string) => `pager:desklock:${deskId}`,
  /** Per-item delivery lock ("outbox:<itemId>"), so the tick and the sleep route never send the same item twice. */
  itemLock: (item: string) => `pager:itemlock:${item}`,
  status: "pager:status",
  ticklog: "pager:ticklog",
} as const;

export const ALERT_HISTORY = 50;
export const TICKLOG_LENGTH = 50;

/** Error with an HTTP status, thrown by store mutations for caller-facing conditions (409 duplicate, 429 desk full…). */
export class StoreError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "StoreError";
  }
}

/* ---------------- JSON helpers ---------------- */

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** JSON.stringify that refuses bigints (uint256 must already be decimal strings). */
function enc(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") throw new TypeError("pager store: bigint values must be serialized to decimal strings first");
    return v;
  });
}

function parseAll<T>(h: Record<string, string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, raw] of Object.entries(h)) {
    const v = parse<T>(raw);
    if (v) out[id] = v;
  }
  return out;
}

const bumpCfg: KvOp = { op: "incr", key: K.cfgver };

/* ---------------- ids ---------------- */

export const newWatchId = (): string => `w_${randomBytes(8).toString("base64url").slice(0, 10)}`;

/** Strips control / bidi-override chars, collapses whitespace, caps length. Output is plain text only. */
export function sanitizeLabel(raw: unknown, max = 80): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/* ---------------- desk mutex ---------------- */

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serializes read-modify-write of one desk record across instances (SET NX PX 10 s, compare-and-delete release).
 * Keep `fn` short: no RPC reads inside (arm the watch first, then commit under the lock).
 */
export async function withDeskLock<T>(deskId: string, fn: () => Promise<T>): Promise<T> {
  const key = K.deskLock(deskId);
  const token = randomBytes(9).toString("base64url");
  for (let i = 0; ; i++) {
    if (await kvOne({ op: "set", key, value: token, px: 10_000, nx: true })) break;
    if (i >= 30) throw new StoreError("Desk is busy, retry in a moment", 409);
    await sleepMs(100);
  }
  try {
    return await fn();
  } finally {
    await kvOne({ op: "delifeq", key, value: token }).catch(() => undefined);
  }
}

/* ---------------- desks ---------------- */

/** Opens a new desk. The returned `deskKey` is shown to the caller exactly once and never stored. */
export async function createDesk(label: string | null, ipHash?: string): Promise<{ deskKey: string; desk: Desk }> {
  const deskKey = newDeskKey();
  const desk: Desk = {
    v: 1,
    id: deskIdFromKey(deskKey),
    createdAt: Date.now(),
    label: label ? sanitizeLabel(label) || null : null,
    watchIds: [],
    channels: { telegram: null, webhook: null },
    policy: { sleepMode: "critical-only" },
    ...(ipHash ? { ipHash } : {}),
  };
  // Global desk cap: anonymous desks never expire on their own, so prune abandoned ones before refusing.
  const cap = maxDesksTotal();
  if ((await kvOne({ op: "hlen", key: K.desk })) >= cap) {
    await pruneAbandonedDesks().catch(() => 0);
    if ((await kvOne({ op: "hlen", key: K.desk })) >= cap) throw new StoreError("Night shift desk capacity reached, try again later", 503);
  }
  // No cfgver bump: a desk without watches is never loaded by the tick (loadForTick reads watch-referenced desks).
  await kvOne({ op: "hset", key: K.desk, fields: { [desk.id]: enc(desk) } });
  return { deskKey, desk };
}

/** Abandoned desk: no watches, no delivery channel, not a system desk, older than this. */
const ABANDONED_DESK_MS = 3 * 86_400_000;

/** Deletes abandoned desks (no watches, no channel, > 3 days old). Returns how many were removed. */
export async function pruneAbandonedDesks(now = Date.now()): Promise<number> {
  const all = parseAll<Desk>(await kvOne({ op: "hgetall", key: K.desk }));
  const dead = Object.values(all)
    .filter((d) => !d.system && d.watchIds.length === 0 && !d.channels.telegram && !d.channels.webhook && now - d.createdAt > ABANDONED_DESK_MS)
    .map((d) => d.id);
  for (let i = 0; i < dead.length; i += 500) await kvOne({ op: "hdel", key: K.desk, fields: dead.slice(i, i + 500) });
  return dead.length;
}

export async function getDesk(id: string): Promise<Desk | null> {
  return parse<Desk>(await kvOne({ op: "hget", key: K.desk, field: id }));
}

export async function getDesks(ids: string[]): Promise<Record<string, Desk>> {
  const vals = await kvOne({ op: "hmget", key: K.desk, fields: ids });
  const out: Record<string, Desk> = {};
  ids.forEach((id, i) => {
    const d = parse<Desk>(vals[i]);
    if (d) out[id] = d;
  });
  return out;
}

/** Blind write of a desk record. Prefer `updateDesk` when the change depends on the current value. */
export async function putDesk(d: Desk): Promise<void> {
  await kvBatch([{ op: "hset", key: K.desk, fields: { [d.id]: enc(d) } }, bumpCfg], { atomic: true });
}

/**
 * Locked read-modify-write of a desk (channels, label, policy, failure counters…). `mutate` may edit in place
 * or return a replacement; returning `null` aborts without writing. Resolves to the stored desk, or null if absent.
 */
export async function updateDesk(id: string, mutate: (d: Desk) => Desk | null | void): Promise<Desk | null> {
  return withDeskLock(id, async () => {
    const cur = await getDesk(id);
    if (!cur) return null;
    const res = mutate(cur);
    if (res === null) return cur;
    const next = res ?? cur;
    next.id = id; // never let a mutator re-key a desk
    await putDesk(next);
    return next;
  });
}

/** Deletes the desk and everything it owns: watches, states, sleep session, wake entry, alert history, outbox items, tg reverse index. */
export async function deleteDesk(id: string): Promise<boolean> {
  return withDeskLock(id, async () => {
    const desk = await getDesk(id);
    if (!desk) return false;
    const outboxIds = Object.keys(await kvOne({ op: "hgetall", key: K.outbox })).filter((oid) => oid.startsWith(`${id}:`));
    const ops: KvOp[] = [
      { op: "hdel", key: K.desk, fields: [id] },
      { op: "hdel", key: K.watch, fields: desk.watchIds },
      { op: "hdel", key: K.wstate, fields: desk.watchIds },
      { op: "del", keys: [K.sleep(id), K.alerts(id)] },
      { op: "zrem", key: K.wake, members: [id] },
      { op: "hdel", key: K.outbox, fields: outboxIds },
      bumpCfg,
    ];
    await kvBatch(ops, { atomic: true });
    // Scripted compare-and-delete kept outside MULTI (only clears the reverse index if it still points here).
    if (desk.channels.telegram) await delTgChat(desk.channels.telegram.chatId, id).catch(() => undefined);
    return true;
  });
}

/* ---------------- watches ---------------- */

export async function getWatch(id: string): Promise<Watch | null> {
  return parse<Watch>(await kvOne({ op: "hget", key: K.watch, field: id }));
}

export async function getWatches(ids: string[]): Promise<Watch[]> {
  const vals = await kvOne({ op: "hmget", key: K.watch, fields: ids });
  return vals.map((v) => parse<Watch>(v)).filter((w): w is Watch => !!w);
}

/** Watches of a desk, in the desk's order. Pass the Desk itself to skip one read. */
export async function listWatches(deskOrId: string | Desk): Promise<Watch[]> {
  const desk = typeof deskOrId === "string" ? await getDesk(deskOrId) : deskOrId;
  if (!desk || !desk.watchIds.length) return [];
  return getWatches(desk.watchIds);
}

/** Updates an existing watch's config (PATCH). Never touches its tick-owned state. */
export async function putWatch(w: Watch): Promise<void> {
  await kvBatch([{ op: "hset", key: K.watch, fields: { [w.id]: enc(w) } }, bumpCfg], { atomic: true });
}

/**
 * Registers a freshly armed watch on its desk (locked): enforces the per-desk cap (429), duplicate
 * chain+target (409) and optional global cap (503), then writes watch + initial state + desk atomically.
 */
export async function addWatch(w: Watch, state: WatchState | null, opts: { maxTotal?: number } = {}): Promise<Watch> {
  return withDeskLock(w.deskId, async () => {
    const [deskRaw, total] = await kvBatch([
      { op: "hget", key: K.desk, field: w.deskId },
      { op: "hlen", key: K.watch },
    ] as const);
    const desk = parse<Desk>(deskRaw);
    if (!desk) throw new StoreError("Desk not found", 404);
    const max = maxWatchesPerDesk();
    if (desk.watchIds.length >= max && !desk.system) throw new StoreError(`Desk is full (max ${max} watches)`, 429);
    if (opts.maxTotal !== undefined && total >= opts.maxTotal) throw new StoreError("Night shift at capacity, try again later", 503);
    const existing = await getWatches(desk.watchIds);
    if (existing.some((x) => x.chainId === w.chainId && x.target.toLowerCase() === w.target.toLowerCase())) {
      throw new StoreError("This desk already watches that target on that chain", 409);
    }
    desk.watchIds = [...desk.watchIds.filter((id) => id !== w.id), w.id];
    const ops: KvOp[] = [
      { op: "hset", key: K.watch, fields: { [w.id]: enc(w) } },
      { op: "hset", key: K.desk, fields: { [desk.id]: enc(desk) } },
      bumpCfg,
    ];
    if (state) ops.push({ op: "hset", key: K.wstate, fields: { [w.id]: enc(state) } });
    await kvBatch(ops, { atomic: true });
    return w;
  });
}

/** Removes a watch from its desk with its state. Returns false when the desk does not own it. */
export async function deleteWatch(deskId: string, id: string): Promise<boolean> {
  return withDeskLock(deskId, async () => {
    const desk = await getDesk(deskId);
    if (!desk || !desk.watchIds.includes(id)) return false;
    desk.watchIds = desk.watchIds.filter((x) => x !== id);
    await kvBatch(
      [
        { op: "hdel", key: K.watch, fields: [id] },
        { op: "hdel", key: K.wstate, fields: [id] },
        { op: "hset", key: K.desk, fields: { [desk.id]: enc(desk) } },
        bumpCfg,
      ],
      { atomic: true }
    );
    return true;
  });
}

export async function countWatchesTotal(): Promise<number> {
  return kvOne({ op: "hlen", key: K.watch });
}

/* ---------------- watch state ---------------- */

export async function getStates(ids: string[]): Promise<Record<string, WatchState>> {
  const vals = await kvOne({ op: "hmget", key: K.wstate, fields: ids });
  const out: Record<string, WatchState> = {};
  ids.forEach((id, i) => {
    const s = parse<WatchState>(vals[i]);
    if (s) out[id] = s;
  });
  return out;
}

export async function getState(id: string): Promise<WatchState | null> {
  return parse<WatchState>(await kvOne({ op: "hget", key: K.wstate, field: id }));
}

/** Writes states outside a tick (e.g. re-arming baselines). The tick itself uses `commitTick`. */
export async function putStates(states: Record<string, WatchState>): Promise<void> {
  const fields = Object.fromEntries(Object.entries(states).map(([id, s]) => [id, enc(s)]));
  await kvOne({ op: "hset", key: K.wstate, fields });
}

/** Empty state for a watch that has never been armed / checked. */
export function blankWatchState(w: Pick<Watch, "id">, now = Date.now(), armedBlock = "0"): WatchState {
  return {
    v: 1,
    watchId: w.id,
    armedAt: now,
    armedBlock,
    lastCheckedAt: null,
    lastCheckedBlock: null,
    lastError: null,
    consecutiveErrors: 0,
    seen: [],
    cooldownUntil: {},
    firing: {},
    lastAlert: null,
    alertCount: 0,
  };
}

/* ---------------- tick ---------------- */

export function blankGlobal(): PagerGlobal {
  return { v: 1, tickCount: 0, cursor: {}, parity: { driftSince: null, lastDelta: null, lastSpreadBps: null }, lastTickAt: null, lastHash: null };
}

export async function getGlobal(): Promise<PagerGlobal> {
  return parse<PagerGlobal>(await kvOne({ op: "get", key: K.global })) ?? blankGlobal();
}

/** Acquires the tick lock (SET NX PX). False when another tick holds it. */
export async function acquireTickLock(tickId: string, ttlMs = 90_000): Promise<boolean> {
  return kvOne({ op: "set", key: K.lock, value: tickId, px: ttlMs, nx: true });
}

/** Compare-and-delete release, so a slow tick never frees a lock a newer tick acquired after expiry. */
export async function releaseTickLock(tickId: string): Promise<void> {
  await kvOne({ op: "delifeq", key: K.lock, value: tickId });
}

type ConfigCache = { ver: string; watches: Watch[]; desks: Record<string, Desk> };
const gc = globalThis as typeof globalThis & { __kestrelPagerCfg?: ConfigCache };

export interface TickLoad {
  watches: Watch[];
  states: Record<string, WatchState>;
  global: PagerGlobal;
  /** Desk ids whose sleep session is due (wakeAt ≤ now), oldest first. */
  dueDesks: string[];
  /** Every desk that owns at least one watch or is due for a digest. */
  desks: Record<string, Desk>;
  cfgver: string;
}

/**
 * Everything one tick needs in ≤ 2 round-trips: [cfgver, all states, global, due wakes] and, only when the
 * config version changed since this instance last looked, [all watches, all desks]. Orphan states (watch
 * deleted mid-tick) are pruned when configs reload.
 */
export async function loadForTick(now: number): Promise<TickLoad> {
  const [ver, stateHash, globalRaw, due] = await kvBatch([
    { op: "get", key: K.cfgver },
    { op: "hgetall", key: K.wstate },
    { op: "get", key: K.global },
    { op: "zrangebyscore", key: K.wake, min: "-inf", max: now, limit: 50 },
  ] as const);
  const cfgver = ver ?? "0";
  let cache = gc.__kestrelPagerCfg;
  let reloaded = false;
  if (!cache || cache.ver !== cfgver) {
    // Only desks that own a watch (HMGET), never the whole desk hash: thousands of abandoned anonymous desks
    // must not be able to push this load past the KV timeout and stall every watch.
    const watches = Object.values(parseAll<Watch>(await kvOne({ op: "hgetall", key: K.watch })));
    const ids = [...new Set(watches.map((w) => w.deskId))];
    const desks: Record<string, Desk> = {};
    for (let i = 0; i < ids.length; i += 500) Object.assign(desks, await getDesks(ids.slice(i, i + 500)));
    cache = { ver: cfgver, watches, desks };
    gc.__kestrelPagerCfg = cache;
    reloaded = true;
  }
  // Desks due for a digest that own no watch (≤ 50 per tick) are read on demand.
  const missingDue = due.filter((id) => !cache!.desks[id]);
  const dueDesks = missingDue.length ? await getDesks(missingDue).catch(() => ({}) as Record<string, Desk>) : {};
  const live = new Set(cache.watches.map((w) => w.id));
  const allStates = parseAll<WatchState>(stateHash);
  const states: Record<string, WatchState> = {};
  const orphans: string[] = [];
  for (const [id, s] of Object.entries(allStates)) (live.has(id) ? (states[id] = s) : orphans.push(id));
  if (reloaded && orphans.length) await kvOne({ op: "hdel", key: K.wstate, fields: orphans }).catch(() => undefined);
  return {
    watches: cache.watches,
    states,
    global: parse<PagerGlobal>(globalRaw) ?? blankGlobal(),
    dueDesks: due,
    desks: missingDue.length ? { ...cache.desks, ...dueDesks } : cache.desks,
    cfgver,
  };
}

export interface CommitTickInput {
  /** Changed states only (the tick compares JSON before/after). */
  states?: Record<string, WatchState>;
  outbox?: OutboxItem[];
  /** Updated sleep sessions (deferred / paged). Written with XX so a session the user ended mid-tick is never resurrected. */
  sleeps?: SleepSession[];
  /** Alert history per desk (LPUSH + LTRIM 50). */
  alerts?: Record<string, PagerAlert[]>;
  global: PagerGlobal;
  status: TickSummary;
  /** Append `status` to the hash-chained tick log (default true). */
  ticklog?: boolean;
}

/** Persists one tick atomically (MULTI/EXEC): states, outbox, sleeps, alert history, global, status, tick log. */
export async function commitTick(input: CommitTickInput): Promise<void> {
  const ops: KvOp[] = [];
  const states = input.states ?? {};
  if (Object.keys(states).length) {
    ops.push({ op: "hset", key: K.wstate, fields: Object.fromEntries(Object.entries(states).map(([id, s]) => [id, enc(s)])) });
  }
  if (input.outbox?.length) {
    ops.push({ op: "hset", key: K.outbox, fields: Object.fromEntries(input.outbox.map((o) => [o.id, enc(o)])) });
  }
  for (const s of input.sleeps ?? []) ops.push({ op: "set", key: K.sleep(s.deskId), value: enc(s), xx: true });
  for (const [deskId, list] of Object.entries(input.alerts ?? {})) ops.push(...alertOps(deskId, list));
  ops.push({ op: "set", key: K.global, value: enc(input.global) });
  ops.push({ op: "set", key: K.status, value: enc(input.status) });
  if (input.ticklog !== false) {
    ops.push({ op: "lpush", key: K.ticklog, values: [enc(input.status)] });
    ops.push({ op: "ltrim", key: K.ticklog, start: 0, stop: TICKLOG_LENGTH - 1 });
  }
  await kvBatch(ops, { atomic: true });
}

export async function getStatus(): Promise<TickSummary | null> {
  return parse<TickSummary>(await kvOne({ op: "get", key: K.status }));
}

/** Newest first. */
export async function ticklog(n = TICKLOG_LENGTH): Promise<TickSummary[]> {
  const raw = await kvOne({ op: "lrange", key: K.ticklog, start: 0, stop: Math.max(0, Math.min(n, TICKLOG_LENGTH) - 1) });
  return raw.map((r) => parse<TickSummary>(r)).filter((x): x is TickSummary => !!x);
}

export async function cfgVersion(): Promise<string> {
  return (await kvOne({ op: "get", key: K.cfgver })) ?? "0";
}

/* ---------------- outbox ---------------- */

/** All pending deliveries, oldest first. */
export async function outboxList(): Promise<OutboxItem[]> {
  return Object.values(parseAll<OutboxItem>(await kvOne({ op: "hgetall", key: K.outbox }))).sort((a, b) => a.createdAt - b.createdAt);
}

export async function outboxPut(items: OutboxItem[]): Promise<void> {
  if (!items.length) return;
  await kvOne({ op: "hset", key: K.outbox, fields: Object.fromEntries(items.map((o) => [o.id, enc(o)])) });
}

export async function outboxUpdate(item: OutboxItem): Promise<void> {
  await outboxPut([item]);
}

/** One outbox item, or null when it was delivered/removed meanwhile. */
export async function outboxGet(id: string): Promise<OutboxItem | null> {
  return parse<OutboxItem>(await kvOne({ op: "hget", key: K.outbox, field: id }));
}

/**
 * Per-item lock (SET NX PX). Resolves to a release token, or null when someone else holds it. Release with
 * `releaseItemLock` (compare-and-delete), so an expired lock re-acquired by another worker is never freed by us.
 */
export async function tryItemLock(item: string, ttlMs = 60_000): Promise<string | null> {
  const token = randomBytes(9).toString("base64url");
  return (await kvOne({ op: "set", key: K.itemLock(item), value: token, px: ttlMs, nx: true })) ? token : null;
}

export async function releaseItemLock(item: string, token: string): Promise<void> {
  await kvOne({ op: "delifeq", key: K.itemLock(item), value: token });
}

export async function outboxRemove(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await kvOne({ op: "hdel", key: K.outbox, fields: ids });
}

/* ---------------- sleep ---------------- */

export async function getSleep(deskId: string): Promise<SleepSession | null> {
  return parse<SleepSession>(await kvOne({ op: "get", key: K.sleep(deskId) }));
}

/** Sleep sessions for many desks in ONE round-trip (tick alert routing). */
export async function getSleeps(deskIds: string[]): Promise<Record<string, SleepSession>> {
  if (!deskIds.length) return {};
  const vals = (await kvBatch(deskIds.map((id) => ({ op: "get" as const, key: K.sleep(id) })))) as (string | null)[];
  const out: Record<string, SleepSession> = {};
  deskIds.forEach((id, i) => {
    const s = parse<SleepSession>(vals[i]);
    if (s) out[id] = s;
  });
  return out;
}

/** Starts or replaces a session and (re)schedules its wake. */
export async function putSleep(s: SleepSession): Promise<void> {
  await kvBatch(
    [
      { op: "set", key: K.sleep(s.deskId), value: enc(s) },
      { op: "zadd", key: K.wake, members: [{ score: s.wakeAt, member: s.deskId }] },
    ],
    { atomic: true }
  );
}

/** Updates a session only if it still exists (never resurrects one ended concurrently). */
export async function updateSleep(s: SleepSession): Promise<boolean> {
  return kvOne({ op: "set", key: K.sleep(s.deskId), value: enc(s), xx: true });
}

/**
 * Atomically claims (GETDEL) and clears a desk's sleep session + wake entry. Exactly one concurrent caller gets the
 * session, so the "I'm awake" route and a tick's due-wake pass can never both build and send the same digest.
 */
export async function takeSleep(deskId: string): Promise<SleepSession | null> {
  const [raw] = await kvBatch(
    [
      { op: "getdel", key: K.sleep(deskId) },
      { op: "zrem", key: K.wake, members: [deskId] },
    ] as const,
    { atomic: true }
  );
  return parse<SleepSession>(raw);
}

export async function deleteSleep(deskId: string): Promise<void> {
  await kvBatch(
    [
      { op: "del", keys: [K.sleep(deskId)] },
      { op: "zrem", key: K.wake, members: [deskId] },
    ],
    { atomic: true }
  );
}

/** Desk ids whose wake time has passed, oldest first. */
export async function dueWakes(now: number, limit = 50): Promise<string[]> {
  return kvOne({ op: "zrangebyscore", key: K.wake, min: "-inf", max: now, limit });
}

/* ---------------- alert history ---------------- */

export interface DigestLogEntry {
  kind: "digest";
  id: string;
  deskId: string;
  at: number;
  digest: DigestPayload;
}
export type AlertLogEntry = PagerAlert | DigestLogEntry;

export const isDigestEntry = (e: AlertLogEntry): e is DigestLogEntry => (e as DigestLogEntry).kind === "digest";

function alertOps(deskId: string, entries: AlertLogEntry[]): KvOp[] {
  if (!entries.length) return [];
  // LPUSH puts the last value at the head, so push oldest → newest to keep the list newest-first.
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  return [
    { op: "lpush", key: K.alerts(deskId), values: sorted.map(enc) },
    { op: "ltrim", key: K.alerts(deskId), start: 0, stop: ALERT_HISTORY - 1 },
  ];
}

export async function pushAlerts(deskId: string, alerts: PagerAlert[]): Promise<void> {
  const ops = alertOps(deskId, alerts);
  if (ops.length) await kvBatch(ops, { atomic: true });
}

export async function pushDigest(deskId: string, digest: DigestPayload): Promise<void> {
  const entry: DigestLogEntry = { kind: "digest", id: `${deskId}:digest:${digest.endedAt}`, deskId, at: digest.endedAt, digest };
  await kvBatch(alertOps(deskId, [entry]), { atomic: true });
}

/** Newest-first history including digests. */
export async function recentLog(deskId: string, n = 20): Promise<AlertLogEntry[]> {
  const raw = await kvOne({ op: "lrange", key: K.alerts(deskId), start: 0, stop: Math.max(0, Math.min(n, ALERT_HISTORY) - 1) });
  return raw.map((r) => parse<AlertLogEntry>(r)).filter((x): x is AlertLogEntry => !!x);
}

/** Newest-first alerts only (digests excluded). */
export async function recentAlerts(deskId: string, n = 20): Promise<PagerAlert[]> {
  return (await recentLog(deskId, ALERT_HISTORY)).filter((e): e is PagerAlert => !isDigestEntry(e)).slice(0, n);
}

/** Newest-first digests only. */
export async function recentDigests(deskId: string, n = 5): Promise<DigestPayload[]> {
  return (await recentLog(deskId, ALERT_HISTORY)).filter(isDigestEntry).slice(0, n).map((e) => e.digest);
}

/* ---------------- telegram linking ---------------- */

export async function createTgLink(token: string, deskId: string, ttlSec = 900): Promise<void> {
  await kvOne({ op: "set", key: K.tglink(token), value: deskId, ex: ttlSec });
}

/** Non-consuming lookup (link status polling). */
export async function peekTgLink(token: string): Promise<string | null> {
  return kvOne({ op: "get", key: K.tglink(token) });
}

/** Single-use: returns the deskId and deletes the token atomically (GETDEL). */
export async function takeTgLink(token: string): Promise<string | null> {
  return kvOne({ op: "getdel", key: K.tglink(token) });
}

export async function setTgChat(chatId: string, deskId: string): Promise<void> {
  await kvOne({ op: "set", key: K.tgchat(chatId), value: deskId });
}

export async function getTgChat(chatId: string): Promise<string | null> {
  return kvOne({ op: "get", key: K.tgchat(chatId) });
}

/** Deletes the reverse index; with `deskId`, only if it still points at that desk. */
export async function delTgChat(chatId: string, deskId?: string): Promise<void> {
  if (deskId) await kvOne({ op: "delifeq", key: K.tgchat(chatId), value: deskId });
  else await kvOne({ op: "del", keys: [K.tgchat(chatId)] });
}

export async function getTgOffset(): Promise<number | null> {
  const v = await kvOne({ op: "get", key: K.tgoffset });
  const n = v === null ? NaN : Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

export async function setTgOffset(offset: number): Promise<void> {
  await kvOne({ op: "set", key: K.tgoffset, value: String(Math.trunc(offset)) });
}

/* ---------------- public views (spec section 13) ---------------- */

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

export function toDeskPublic(desk: Desk, opts: { revealSecret?: boolean } = {}): DeskPublic {
  const tg = desk.channels.telegram;
  const wh = desk.channels.webhook;
  return {
    id: desk.id,
    createdAt: desk.createdAt,
    label: desk.label,
    storage: kvMode(),
    watchCount: desk.watchIds.length,
    limits: { maxWatches: maxWatchesPerDesk() },
    policy: desk.policy,
    ...(desk.system ? { system: true } : {}),
    channels: {
      telegram: tg
        ? { linked: !tg.disabledReason, username: tg.username, chatType: tg.chatType, verified: tg.verified, disabledReason: tg.disabledReason }
        : null,
      webhook: wh
        ? {
            host: hostOf(wh.url),
            kind: wh.kind,
            failures: wh.failures,
            disabledReason: wh.disabledReason,
            ...(opts.revealSecret && wh.kind === "generic" ? { secret: wh.secret } : {}),
          }
        : null,
    },
  };
}

export function toSleepPublic(s: SleepSession | null): SleepPublic | null {
  if (!s) return null;
  return { startedAt: s.startedAt, wakeAt: s.wakeAt, tz: s.tz, policy: s.policy, deferredCount: s.deferred.length, pagedCount: s.paged.length };
}

/** Signed change in basis points between two non-negative uint strings (BigInt math, clamped for display). */
function deltaBps(from: string, to: string): number | null {
  try {
    const a = BigInt(from);
    const b = BigInt(to);
    if (a <= 0n) return null;
    const bps = ((b - a) * 10_000n) / a;
    const capped = bps > 10_000_000n ? 10_000_000n : bps < -10_000_000n ? -10_000_000n : bps;
    return Number(capped);
  } catch {
    return null;
  }
}

const safeUnits = (v: string, decimals: number, frac = 4): string | null => {
  try {
    return fmtUnits(v, decimals, frac);
  } catch {
    return null;
  }
};

/** Display-ready metric strings from a watch's state (no raw internals). */
function metricsFor(w: Watch, s: WatchState | null): Record<string, string> {
  const m: Record<string, string> = {};
  if (!s) return m;
  if (s.pool?.samples.length) {
    const cur = s.pool.samples[0];
    const armed = s.pool.armed;
    const dl = deltaBps(armed.liq, cur.liq);
    if (dl !== null) m.liquidity = `${fmtBps(dl)} vs armed`;
    const dp = deltaBps(armed.px, cur.px);
    if (dp !== null) m.price = `${fmtBps(dp)} vs armed`;
    const depth = safeUnits(cur.wethDepth, 18, 3);
    if (depth !== null) m.wethDepth = `${depth} WETH`;
  }
  if (s.supply) {
    const dec = w.meta.token?.decimals ?? 18;
    const sym = w.meta.token?.symbol ? ` ${sanitizeLabel(w.meta.token.symbol, 16)}` : "";
    const sup = safeUnits(s.supply.last, dec, 2);
    if (sup !== null) m.supply = `${sup}${sym}`;
    const ds = deltaBps(s.supply.armed, s.supply.last);
    if (ds !== null && ds !== 0) m.supplyChange = `${fmtBps(ds)} vs armed`;
  }
  if (s.wallet) {
    const bal = safeUnits(s.wallet.balance, 18, 5);
    if (bal !== null) m.balance = `${bal} ETH`;
    if (s.wallet.nonce !== null) m.nonce = String(s.wallet.nonce);
    const open = Object.keys(s.wallet.openApprovals).length;
    if (open) m.openApprovals = `${open} alerted, not revoked`;
  }
  if (s.code) {
    if (s.code.impl) m.implementation = shortAddr(s.code.impl);
    if (s.code.owner) m.owner = shortAddr(s.code.owner);
    if (s.code.safe) m.safe = `${s.code.safe.threshold}-of-${s.code.safe.owners.length}`;
    if (s.code.paused) m.paused = "PAUSED";
  }
  if (s.escrow) {
    m.campaign = CAMPAIGN_STATES[s.escrow.state] ?? `state ${s.escrow.state}`;
    m.nextTranche = s.escrow.nextTranche >= 7 ? "all released" : `#${s.escrow.nextTranche}`;
    if (s.escrow.challengeState) m.challenge = `state ${s.escrow.challengeState}`;
  }
  if (s.peers) {
    // Only numeric keys are LayerZero peer eids ("30184"); the rest is lane state ("<chainId>:paused|pauser|limit|window")
    // and adapter governance ("gov:<chainId>:owner|threshold|owners") kept by the bridge lane guard.
    const peers = Object.keys(s.peers).filter((k) => /^\d+$/.test(k)).length;
    if (peers) m.peers = `${peers} OFT peer${peers > 1 ? "s" : ""} tracked`;
  }
  if (s.scan) m.band = `${s.scan.band} ${s.scan.score}/100`;
  return m;
}

const RECENT_ALERT_MS = 60 * 60_000;

export function toWatchView(w: Watch, s: WatchState | null, now = Date.now()): WatchView {
  let status: WatchView["status"] = "ok";
  if (!s || s.lastCheckedAt === null) status = "pending";
  else if (s.lastError && s.consecutiveErrors > 0) status = "error";
  else if (
    Object.values(s.firing).some(Boolean) ||
    (s.lastAlert && s.lastAlert.severity !== "info" && now - s.lastAlert.at < RECENT_ALERT_MS)
  )
    status = "alerting";
  return {
    ...w,
    status,
    state: {
      lastCheckedAt: s?.lastCheckedAt ?? null,
      lastCheckedBlock: s?.lastCheckedBlock ?? null,
      lastError: s?.lastError ?? null,
      lastAlert: s?.lastAlert ?? null,
      alertCount: s?.alertCount ?? 0,
      metrics: metricsFor(w, s),
    },
  };
}

/** Watches of a desk with their public views (one HMGET for configs + one for states). */
export async function listWatchViews(desk: Desk): Promise<WatchView[]> {
  if (!desk.watchIds.length) return [];
  const [wRaw, sRaw] = await kvBatch([
    { op: "hmget", key: K.watch, fields: desk.watchIds },
    { op: "hmget", key: K.wstate, fields: desk.watchIds },
  ] as const);
  const now = Date.now();
  const out: WatchView[] = [];
  desk.watchIds.forEach((_id, i) => {
    const w = parse<Watch>(wRaw[i]);
    if (w) out.push(toWatchView(w, parse<WatchState>(sRaw[i]), now));
  });
  return out;
}
