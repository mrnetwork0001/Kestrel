/**
 * The Night-Shift tick (spec §9): one batched, lock-guarded pass over every enabled watch.
 *
 *   1. SET lock NX PX (duplicate scheduler deliveries → `skipped: "locked"`)
 *   2. drain Telegram getUpdates (polling mode only) so /start links bind even without a webhook
 *   3. load watches + states + global + due wakes (≤ 2 KV round-trips; configs cached by cfgver)
 *   4. probe Base ‖ Robinhood: one multicall + slot batch + a few getLogs per chain (cursor → latest)
 *   5. evaluate every watch (pure), apply the Sleep-Mode policy per desk
 *   6. commit states + outbox + sleeps + alert history + global atomically (cursors advance ONLY for chains that probed OK)
 *   7. deliver the outbox (this tick's items + leftovers), concurrency-limited, inside the time budget
 *   8. due "While You Slept" digests (≤ 3 per tick)
 *   9. append the hash-chained TickSummary to the public Night-Shift Log, release the lock
 *
 * Exactly-once facts, at-least-once pages: dedupe keys live in WatchState and are committed in the same MULTI as
 * the outbox, so a crash after commit re-delivers from the outbox and never re-fires the alert.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ChainId } from "@/lib/engine/types";
import { kvMissingInProd } from "@/lib/kv";
import { applyDeliveryOutcomes, deliverOutboxItem, telegramActive, type Delivery } from "@/lib/pager/deliver";
import { routeAlertsForSleep, runDueDigests } from "@/lib/pager/digest";
import { applyScan, computeGlobals, evaluateWatch, markErrored, scanDue } from "@/lib/pager/evaluate";
import { buildPlan, prefetchChangedImpls, probeChain, type ChainSnapshot } from "@/lib/pager/probes";
import * as store from "@/lib/pager/store";
import { pollTelegramUpdates, tgConfigured, tgMode } from "@/lib/pager/telegram";
import type { Desk, OutboxItem, PagerAlert, PagerGlobal, SleepSession, TickSummary, Watch, WatchState } from "@/lib/pager/types";

export interface TickOptions {
  reason: string;
  executionId?: string | null;
  /** Evaluate live state without taking the lock, persisting, delivering or polling Telegram. */
  dryRun?: boolean;
  /** Soft time budget in ms (default PAGER_TICK_BUDGET_MS or 40 s; the route's maxDuration is 60 s). */
  budgetMs?: number;
}

export interface TickPreviewAlert {
  deskId: string;
  watchId: string;
  label: string;
  severity: PagerAlert["severity"];
  title: string;
  lines: string[];
  block: string;
  route: "page" | "defer" | "history-only";
}

export type TickResult = TickSummary & {
  dryRun?: true;
  preview?: { alerts: TickPreviewAlert[]; watchErrors: { watchId: string; error: string }[] };
  telegram?: { processed: number; linked: number; error?: string };
};

const CHAINS: ChainId[] = [8453, 4663];
const MAX_OUTBOX_ATTEMPTS = 5;
const OUTBOX_MAX_AGE_MS = 24 * 3_600_000;
const DELIVERY_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 25_000;

const envInt = (name: string, dflt: number, min: number, max: number) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

/* ------------------------------------------------------------------ hash chain */

/** Canonical hash of a tick summary: sha256(prevHash + JSON(summary without `hash`)), hex. */
export function hashSummary(s: Omit<TickSummary, "hash"> | TickSummary): string {
  const { hash: _omit, ...rest } = s as TickSummary;
  return createHash("sha256").update(`${rest.prevHash ?? ""}${JSON.stringify(rest)}`).digest("hex");
}

/** Verifies a newest-first tick log: every entry's hash recomputes, and each links to the one before it. */
export function verifyTickChain(logNewestFirst: TickSummary[]): { valid: boolean; checked: number; brokenAt: string | null } {
  for (let i = 0; i < logNewestFirst.length; i++) {
    const e = logNewestFirst[i];
    if (hashSummary(e) !== e.hash) return { valid: false, checked: i, brokenAt: e.tickId };
    const older = logNewestFirst[i + 1];
    if (older && e.prevHash !== older.hash) return { valid: false, checked: i, brokenAt: e.tickId };
  }
  return { valid: true, checked: logNewestFirst.length, brokenAt: null };
}

/* ------------------------------------------------------------------ helpers */

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), Math.max(1, ms));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200);

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !stop()) await fn(items[i++]);
  });
  await Promise.all(workers);
}

function blankState(w: Watch, now: number): WatchState {
  return store.blankWatchState(w, now);
}

/**
 * band_change pass: at most PAGER_SCANS_PER_TICK full scans (scanTarget, deterministic, no LLM), oldest first,
 * only while ≥ 15 s of budget remain; the rest carry over to the next tick. Mutates `nextStates` / `alerts`.
 */
async function runDueScans(
  active: Watch[],
  states: Record<string, WatchState>,
  nextStates: Record<string, WatchState>,
  snap: Partial<Record<ChainId, ChainSnapshot>>,
  now: number,
  deadline: number,
  alerts: PagerAlert[]
): Promise<number> {
  const max = envInt("PAGER_SCANS_PER_TICK", 2, 0, 10);
  if (!max) return 0;
  const due = active
    .filter((w) => snap[w.chainId] && scanDue(w, nextStates[w.id] ?? states[w.id], now))
    .sort((a, b) => ((nextStates[a.id] ?? states[a.id])?.scan?.at ?? 0) - ((nextStates[b.id] ?? states[b.id])?.scan?.at ?? 0))
    .slice(0, max);
  if (!due.length) return 0;
  const { scanDegradedReasons, scanTarget } = await import("@/lib/engine/scan");
  let scans = 0;
  for (const w of due) {
    if (deadline - Date.now() < 15_000) break;
    try {
      const r = await withTimeout(scanTarget(w.chainId, w.target, { useLlm: false }), Math.min(20_000, deadline - Date.now() - 5_000), "band scan");
      // Degraded scans carry degradation points and miss findings: never compare them for band changes.
      if (scanDegradedReasons(r).length) {
        console.warn(`[pager] band scan ${w.id} degraded; skipped`);
        continue;
      }
      const st = structuredClone(nextStates[w.id] ?? states[w.id] ?? blankState(w, now));
      const out = applyScan({ now, snap }, w, st, { score: r.score, band: r.band, block: { number: r.block.number }, findings: r.findings });
      nextStates[w.id] = st;
      alerts.push(...out.map((a) => ({ ...a, deskId: w.deskId, watchId: w.id })));
      scans++;
    } catch (e) {
      console.warn(`[pager] band scan ${w.id} failed: ${errText(e)}`);
    }
  }
  return scans;
}

/* ------------------------------------------------------------------ delivery loop */

interface DeliveryStats {
  ok: number;
  failed: number;
}

/**
 * Delivers pending outbox items (oldest first) until the deadline. Successful channels are marked "sent" and
 * never repeated; items are removed when every channel is done, after MAX_OUTBOX_ATTEMPTS, or after 24 h.
 * Each item is sent under a per-item lock and re-read inside it, so a concurrent sender (the sleep route's
 * "I'm awake" digest, an overlapping manual tick) never sends the same item twice.
 * Channel health (webhook failure counters, Telegram blocked/migrated chats) is written back to the desk.
 */
export async function deliverOutbox(opts: { deadline: number; desks?: Record<string, Desk>; labels?: Record<string, string>; only?: OutboxItem[] }): Promise<{ stats: DeliveryStats; deliveries: Delivery[] }> {
  const stats: DeliveryStats = { ok: 0, failed: 0 };
  const all: Delivery[] = [];
  const items = opts.only ?? (await store.outboxList());
  if (!items.length) return { stats, deliveries: all };
  const now = Date.now();
  const drop: string[] = [];
  const live: OutboxItem[] = [];
  for (const it of items) {
    if (it.attempts >= MAX_OUTBOX_ATTEMPTS || now - it.createdAt > OUTBOX_MAX_AGE_MS) drop.push(it.id);
    else live.push(it);
  }
  const missing = [...new Set(live.map((i) => i.deskId))].filter((id) => !opts.desks?.[id]);
  const desks: Record<string, Desk> = { ...(opts.desks ?? {}), ...(missing.length ? await store.getDesks(missing) : {}) };
  const outcomes = new Map<string, Delivery[]>();

  await pool(
    live,
    DELIVERY_CONCURRENCY,
    async (item) => {
      const desk = desks[item.deskId];
      if (!desk) {
        drop.push(item.id);
        return;
      }
      const lockId = `outbox:${item.id}`;
      const token = await store.tryItemLock(lockId).catch(() => null);
      if (!token) return; // another sender holds this item right now; whatever it leaves pending is retried next tick
      let cur: OutboxItem | null = item;
      try {
        // Re-read under the lock: the other sender may have finished (removed) it or advanced its channel status.
        cur = (await store.outboxGet(item.id)) ?? (opts.only ? item : null);
        if (!cur) return;
        const r = await deliverOutboxItem(desk, cur, { labels: opts.labels });
        for (const d of r.deliveries) (d.ok ? stats.ok++ : stats.failed++, all.push(d));
        if (r.deliveries.length) outcomes.set(desk.id, [...(outcomes.get(desk.id) ?? []), ...r.deliveries]);
        // Settle the item before releasing the lock, so the next holder never sees a stale "pending" status.
        if (r.done) await store.outboxRemove([cur.id]);
        else await store.outboxUpdate({ ...cur, status: r.status, attempts: cur.attempts + 1 });
      } catch (e) {
        stats.failed++;
        console.warn(`[pager] outbox ${item.id.slice(0, 12)}… failed: ${errText(e)}`);
        if (cur) await store.outboxUpdate({ ...cur, attempts: cur.attempts + 1 }).catch(() => undefined);
      } finally {
        await store.releaseItemLock(lockId, token).catch(() => undefined);
      }
    },
    () => opts.deadline - Date.now() < 3_000
  );

  if (drop.length) await store.outboxRemove([...new Set(drop)]).catch((e) => console.warn(`[pager] outbox cleanup failed: ${errText(e)}`));
  for (const [deskId, ds] of outcomes) {
    if (!applyDeliveryOutcomes(desks[deskId], ds).changed) continue;
    await store
      .updateDesk(deskId, (d) => {
        const r = applyDeliveryOutcomes(d, ds);
        return r.changed ? r.desk : null;
      })
      .catch((e) => console.warn(`[pager] desk channel update failed: ${errText(e)}`));
  }
  return { stats, deliveries: all };
}

/* ------------------------------------------------------------------ the tick */

export async function runTick(o: TickOptions): Promise<TickResult> {
  const started = Date.now();
  const deadline = started + (o.budgetMs ?? envInt("PAGER_TICK_BUDGET_MS", 40_000, 5_000, 280_000));
  const tickId = (o.executionId && /^[A-Za-z0-9_.:-]{1,128}$/.test(o.executionId) ? o.executionId : null) ?? `t_${started.toString(36)}${randomBytes(3).toString("hex")}`;
  const base = (over: Partial<TickSummary> = {}): TickSummary => {
    const s: Omit<TickSummary, "hash"> = {
      tickId,
      reason: o.reason,
      startedAt: started,
      durationMs: Date.now() - started,
      chains: {},
      watches: 0,
      evaluated: 0,
      alerts: 0,
      deferred: 0,
      deliveries: { ok: 0, failed: 0 },
      digests: 0,
      scans: 0,
      prevHash: null,
      ...over,
    };
    return { ...s, hash: hashSummary(s) };
  };

  if (kvMissingInProd()) return base({ skipped: "no-storage" });

  let locked = false;
  if (!o.dryRun) {
    // The lock must outlive the whole tick (budget + commit/delivery margin), or a second tick could load the same
    // pre-commit states and page the same alert twice.
    locked = await store.acquireTickLock(tickId, Math.max(90_000, deadline - started + 30_000));
    if (!locked) return base({ skipped: "locked" });
  }

  try {
    // 2) Telegram polling mode: bind any /start tokens even when no UI is polling.
    let telegram: TickResult["telegram"];
    if (!o.dryRun && tgConfigured() && tgMode() === "polling") {
      telegram = await withTimeout(pollTelegramUpdates({ maxBatches: 2 }), 8_000, "telegram poll").catch((e) => ({ processed: 0, linked: 0, error: errText(e) }));
    }

    // 3) load
    const load = await store.loadForTick(started);
    const { states, global, dueDesks, desks } = load;
    const active = load.watches.filter((w) => w.enabled && desks[w.deskId]);
    const labels = Object.fromEntries(load.watches.map((w) => [w.id, w.label]));

    // 4) probe both chains (even with no watches, so the public log proves the sentinel sees live chain heads)
    const plan = buildPlan(active, states);
    const settled = await Promise.allSettled(
      CHAINS.map((cid) => {
        const c = global.cursor[cid];
        const cursor = c && /^\d+$/.test(c) ? BigInt(c) : null;
        return withTimeout(probeChain(cid, plan, cursor), Math.min(PROBE_TIMEOUT_MS, Math.max(2_000, deadline - Date.now() - 8_000)), `${cid} probe`);
      })
    );
    const snap: Partial<Record<ChainId, ChainSnapshot>> = {};
    const chains: TickSummary["chains"] = {};
    settled.forEach((r, i) => {
      const cid = CHAINS[i];
      if (r.status === "fulfilled") {
        snap[cid] = r.value;
        chains[cid] = {
          from: r.value.range.from.toString(),
          to: r.value.range.to.toString(),
          gapBlocks: r.value.range.gapBlocks.toString(),
          ok: true,
          ...(r.value.errors.length ? { error: r.value.errors.join("; ").slice(0, 200) } : {}),
        };
      } else {
        const prev = global.cursor[cid] ?? "0";
        chains[cid] = { from: prev, to: prev, gapBlocks: "0", ok: false, error: errText(r.reason) };
      }
    });

    // 5) evaluate (pure)
    const newImplCode = active.length ? await withTimeout(prefetchChangedImpls(active, states, snap), 8_000, "impl prefetch").catch(() => ({})) : {};
    const globals = computeGlobals(snap, global);
    const nextStates: Record<string, WatchState> = {};
    const fresh: PagerAlert[] = [];
    const watchErrors: { watchId: string; error: string }[] = [];
    let evaluated = 0;
    for (const w of active) {
      const prev = states[w.id] ?? blankState(w, started);
      let next: WatchState;
      const s = snap[w.chainId];
      if (!s) {
        next = markErrored(prev, `chain probe failed: ${chains[w.chainId]?.error ?? "unknown error"}`, started);
        watchErrors.push({ watchId: w.id, error: next.lastError ?? "probe failed" });
      } else {
        try {
          const r = evaluateWatch({ now: started, snap, globals, newImplCode }, w, prev);
          next = r.next;
          fresh.push(...r.alerts.map((a) => ({ ...a, deskId: w.deskId, watchId: w.id })));
          evaluated++;
        } catch (e) {
          next = markErrored(prev, `evaluation failed: ${errText(e)}`, started);
          watchErrors.push({ watchId: w.id, error: next.lastError ?? "evaluation failed" });
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(states[w.id] ?? null)) nextStates[w.id] = next;
    }

    // band_change scans (time permitting; skipped on dry runs to keep them fast and side-effect free)
    const scans = o.dryRun ? 0 : await runDueScans(active, states, nextStates, snap, started, deadline, fresh);

    // Sleep-Mode policy, one outbox message per desk
    const byDesk = new Map<string, PagerAlert[]>();
    for (const a of fresh) byDesk.set(a.deskId, [...(byDesk.get(a.deskId) ?? []), a]);
    const outbox: OutboxItem[] = [];
    const sleeps: SleepSession[] = [];
    const history: Record<string, PagerAlert[]> = {};
    const preview: TickPreviewAlert[] = [];
    let deferred = 0;
    const sessions = byDesk.size ? await store.getSleeps([...byDesk.keys()]).catch(() => ({}) as Record<string, SleepSession>) : {};
    for (const [deskId, list] of byDesk) {
      const desk = desks[deskId];
      let page = list;
      let held: PagerAlert[] = [];
      let wokeYou = false;
      const session = sessions[deskId] ?? null;
      if (session) {
        const r = routeAlertsForSleep(session, list);
        page = r.page;
        held = r.defer;
        wokeYou = r.wokeYou;
        sleeps.push(r.session);
        deferred += held.length;
      }
      history[deskId] = [...page, ...held];
      const tg = telegramActive(desk);
      const wh = !!desk?.channels.webhook && !desk.channels.webhook.disabledReason;
      if (page.length && (tg || wh)) {
        outbox.push({
          id: `${deskId}:${tickId}`,
          deskId,
          kind: "alerts",
          alerts: page,
          status: { ...(tg ? { telegram: "pending" as const } : {}), ...(wh ? { webhook: "pending" as const } : {}) },
          attempts: 0,
          createdAt: started,
          // Persisted on the item so a retry in a later tick still opens with "Woke you because:".
          ...(wokeYou ? { wokeYou: true } : {}),
        });
      }
      for (const a of page) preview.push({ deskId, watchId: a.watchId, label: labels[a.watchId] ?? "", severity: a.severity, title: a.title, lines: a.lines, block: a.block, route: tg || wh ? "page" : "history-only" });
      for (const a of held) preview.push({ deskId, watchId: a.watchId, label: labels[a.watchId] ?? "", severity: a.severity, title: a.title, lines: a.lines, block: a.block, route: "defer" });
    }

    // global: cursors advance only for chains that probed OK, and only as far as their LOGS were processed:
    // a failed log window (logsOk=false → logsCursor = range.from − 1) is retried next tick (dedupe keys in
    // WatchState prevent double alerts), never silently skipped for approvals / burns / transfers / admin logs.
    const cursor = { ...global.cursor };
    for (const cid of CHAINS) {
      const s = snap[cid];
      if (!s) continue;
      const prev = cursor[cid] && /^\d+$/.test(cursor[cid]!) ? BigInt(cursor[cid]!) : null;
      const next = s.logsCursor;
      if (prev === null || next > prev) cursor[cid] = next.toString();
    }
    const nextGlobal: PagerGlobal = {
      ...global,
      v: 1,
      tickCount: global.tickCount + 1,
      cursor,
      parity: globals.parityState ?? global.parity,
      lastTickAt: started,
    };

    const skipped = active.length === 0 && dueDesks.length === 0 ? ("no-watches" as const) : undefined;
    const partial = {
      chains,
      watches: active.length,
      evaluated,
      alerts: fresh.length,
      deferred,
      scans,
      prevHash: global.lastHash,
      ...(skipped ? { skipped } : {}),
    };

    if (o.dryRun) {
      return { ...base(partial), dryRun: true, preview: { alerts: preview, watchErrors } };
    }

    // 6) commit facts + outbox atomically (status / tick log are appended after delivery)
    const provisional = base(partial);
    await store.commitTick({ states: nextStates, outbox, sleeps, alerts: history, global: { ...nextGlobal, lastHash: global.lastHash }, status: provisional, ticklog: false });

    // 7) deliver: this tick's items + leftovers from earlier ticks
    const d1 = deadline - Date.now() > 4_000 ? await deliverOutbox({ deadline, desks, labels }) : { stats: { ok: 0, failed: 0 }, deliveries: [] };

    // 8) due digests: finishSleep builds, queues and delivers each one (failed channels stay in the outbox)
    let digests = 0;
    const d2: DeliveryStats = { ok: 0, failed: 0 };
    if (dueDesks.length) {
      const r = await runDueDigests(dueDesks, { deadline, now: Date.now() });
      digests = r.done.length;
      for (const d of r.delivered) d.ok ? d2.ok++ : d2.failed++;
    }

    // 9) hash-chained summary → status + public Night-Shift Log
    const final = base({ ...partial, deliveries: { ok: d1.stats.ok + d2.ok, failed: d1.stats.failed + d2.failed }, digests });
    await store.commitTick({ global: { ...nextGlobal, lastHash: final.hash }, status: final, ticklog: true });
    return { ...final, ...(telegram ? { telegram } : {}) };
  } finally {
    if (locked) await store.releaseTickLock(tickId).catch(() => undefined);
  }
}
