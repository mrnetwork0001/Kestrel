import "server-only";
import { createHash } from "node:crypto";
import { decodeAbiParameters } from "viem";
import { CONTRACTS, KNOWN_LABELS, SPENDERS } from "@/config/contracts";
import { v2PricesScaled18, v3PricesScaled18, v3VirtualReserves } from "@/lib/amm-math";
import { RISKY_SELECTORS, parseAddressFromSlot } from "@/lib/bytecode-signatures";
import { quoteAssetFor, quoteSideOf } from "@/lib/engine/sides";
import type { ChainId, Severity } from "@/lib/engine/types";
import { chainName, fmtBps, fmtDuration, fmtUnits, fmtUtc, shortAddr } from "@/lib/format";
import {
  BRIDGE_LANE_ENFORCER,
  BRIDGE_LANE_NAME,
  CREDIT_HEADROOM_REARM_BPS,
  CREDIT_HEADROOM_WARN_BPS,
  MULTICALL3,
  PERMIT2,
  POOL_SAMPLES_MAX,
  SEEN_MAX,
  SLOTS,
  T,
  UNLIMITED_THRESHOLD,
  VIBES_ADMIN_SAFE,
} from "./constants";
import { evidenceLinks, watchActions, type LinkRef } from "./links";
import { type ChainSnapshot, currentLogicSlots, type ImplCode, NUM_TRANCHES, OP_SELFDESTRUCT } from "./probes";
import { describeThreshold, RULE_CATALOGUE } from "./rules";
import type { Hex, PagerAlert, PagerGlobal, PoolSample, RuleConfig, RuleType, Watch, WatchState } from "./types";

/**
 * Night-Shift Pager evaluator (spec §8): pure `(ctx, watch, prevState) → { alerts, next, observations }`.
 * No I/O. Works on a structuredClone of the previous state so the tick can diff JSON and HSET only
 * changed states. Baselines, hysteresis (`firing`), cooldowns and dedupe keys (`seen`) all live in
 * the watch state: no Redis key per alert. A missing baseline is seeded silently (never an alert),
 * and an unavailable read produces an "unavailable" observation, never a guessed value.
 */

/* ------------------------------------------------------------------------------------------------ */
/* Context                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface ParityGlobal {
  locked: bigint; // Base VIBES.balanceOf(adapter)
  circulating: bigint; // RH totalSupply − reserve
  delta: bigint; // locked − circulating (signed)
  driftSince: number | null; // start of the current locked > circulating episode (ms)
  baseBlock: string;
  rhBlock: string;
}

export interface EvalGlobals {
  parity: ParityGlobal | null;
  /** + ⇒ Robinhood quotes more VIBES per WETH (VIBES cheaper on Robinhood). */
  spreadBps: number | null;
  cheaperVenue: "base" | "robinhood" | null;
  feeDragBps: number | null;
  baseVibesPerWeth: string | null;
  rhVibesPerWeth: string | null;
}

export interface EvalContext {
  now: number;
  snap: Partial<Record<ChainId, ChainSnapshot>>;
  globals: EvalGlobals;
  /** Action links for a watch (defaults to links.ts `watchActions`; hrefs app-relative). */
  links?: (w: Watch, extra?: Record<string, string>) => LinkRef[];
  /** Risky selector sets of new implementations, keyed by lowercase logic (or beacon) address. */
  newImplSelectors?: Record<string, string[]>;
  /** Richer form from probes.prefetchChangedImpls (selectors + byte size). Preferred over newImplSelectors. */
  newImplCode?: Record<string, ImplCode>;
  /** Arm-time baseline pass: seed every baseline, evaluate no rule, return no alerts. */
  seedOnly?: boolean;
}

export interface RuleObservation {
  ruleId: string;
  type: RuleType;
  fired: boolean;
  severity: Severity | null;
  observed: string;
  threshold: string;
}

export const EMPTY_GLOBALS: EvalGlobals = { parity: null, spreadBps: null, cheaperVenue: null, feeDragBps: null, baseVibesPerWeth: null, rhVibesPerWeth: null };

/* ------------------------------------------------------------------------------------------------ */
/* Helpers                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/** floor(sqrt(n)) in BigInt. The seed 2^(bits/2+1) ≥ √n, so Newton descends monotonically. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

const dropBps = (peak: bigint, now: bigint) => (peak > 0n && now < peak ? Number(((peak - now) * 10_000n) / peak) : 0);
const changeBps = (from: bigint, to: bigint) => (from > 0n ? Number(((to - from) * 10_000n) / from) : 0);
const lc = (a: string | null | undefined) => (a ? a.toLowerCase() : null);
const pad32 = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const topicAddr = (t: string | undefined) => (t && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const pctStr = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const label = (addr: string) => KNOWN_LABELS[addr.toLowerCase()] ?? shortAddr(addr);
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

function fire(st: WatchState, key: string): boolean {
  if (st.seen.includes(key)) return false;
  st.seen = [key, ...st.seen].slice(0, SEEN_MAX);
  return true;
}
const cooling = (st: WatchState, r: RuleConfig, now: number) => (st.cooldownUntil[r.id] ?? 0) > now;
function startCooldown(st: WatchState, r: RuleConfig, now: number) {
  const min = r.cooldownMin ?? RULE_CATALOGUE[r.type].defaultCooldownMin;
  if (min > 0) st.cooldownUntil[r.id] = now + min * 60_000;
}

function val<T>(snap: ChainSnapshot | undefined, address: string, functionName: string, args?: readonly unknown[]): T | undefined {
  if (!snap) return undefined;
  const r = snap.call({ address, functionName, args });
  return r.ok ? (r.result as T) : undefined;
}

interface Out {
  alerts: PagerAlert[];
  obs: RuleObservation[];
}

function observe(out: Out, r: RuleConfig, fired: boolean, severity: Severity | null, observed: string) {
  out.obs.push({ ruleId: r.id, type: r.type, fired, severity, observed, threshold: describeThreshold(r) });
}

interface AlertOpts {
  txHash?: string | null;
  chainId?: ChainId; // chain the evidence lives on (defaults to the watch chain)
  evidenceAddress?: string;
  block?: string;
  actions?: LinkRef[];
  resolves?: string;
}

export function alertId(watchId: string, dedupeKey: string): string {
  return createHash("sha256").update(`${watchId}:${dedupeKey}`).digest("hex").slice(0, 16);
}

function mkAlert(ctx: EvalContext, w: Watch, r: RuleConfig, severity: Severity, title: string, lines: string[], dedupeKey: string, o: AlertOpts = {}): PagerAlert {
  const chainId = o.chainId ?? w.chainId;
  const tx = o.txHash && /^0x[0-9a-fA-F]{64}$/.test(o.txHash) ? (o.txHash as Hex) : null;
  const block = o.block ?? ctx.snap[chainId]?.block.number.toString() ?? ctx.snap[w.chainId]?.block.number.toString() ?? "0";
  return {
    id: alertId(w.id, dedupeKey),
    deskId: w.deskId,
    watchId: w.id,
    ruleId: r.id,
    ruleType: r.type,
    severity,
    title: title.slice(0, 200),
    lines: lines.filter(Boolean).map((l) => l.slice(0, 400)),
    chainId,
    target: w.target,
    block,
    txHash: tx,
    evidence: evidenceLinks(chainId, o.evidenceAddress ?? w.target, tx),
    actions: o.actions ?? (ctx.links ? ctx.links(w) : watchActions(w)),
    at: ctx.now,
    ...(o.resolves ? { resolves: o.resolves } : {}),
  };
}

/** A fresh, baseline-less state (the evaluator seeds baselines on first sight). */
export function blankState(w: Pick<Watch, "id">, now = Date.now(), block = "0"): WatchState {
  return {
    v: 1,
    watchId: w.id,
    armedAt: now,
    armedBlock: block,
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

/** For the tick: the watch's chain could not be probed this tick (state keeps its baselines). */
export function markErrored(prev: WatchState, reason: string, now = Date.now()): WatchState {
  const st = structuredClone(prev);
  st.lastError = reason.slice(0, 200);
  st.consecutiveErrors = (st.consecutiveErrors ?? 0) + 1;
  st.lastCheckedAt = st.lastCheckedAt ?? null;
  void now;
  return st;
}

/* ------------------------------------------------------------------------------------------------ */
/* Globals: parity + spread from the $VIBES reads already in the per-chain multicalls                */
/* ------------------------------------------------------------------------------------------------ */

/**
 * `prev` is the last tick's PagerGlobal (or just its `.parity`); the returned `parityNext` (alias
 * `parityState`) must be persisted as PagerGlobal.parity (driftSince = start of the current
 * locked > circulating episode).
 */
export function computeGlobals(
  snap: Partial<Record<ChainId, ChainSnapshot>>,
  prev: PagerGlobal | PagerGlobal["parity"] | null = null,
  now = Date.now()
): EvalGlobals & { parityNext: PagerGlobal["parity"]; parityState: PagerGlobal["parity"] } {
  const prevParity: PagerGlobal["parity"] | null = prev && "tickCount" in prev ? prev.parity : (prev as PagerGlobal["parity"] | null);
  const b = snap[8453];
  const r = snap[4663];
  const locked = val<bigint>(b, CONTRACTS.base.vibesToken, "balanceOf", [CONTRACTS.base.vibesBridgeAdapter]);
  const supply = val<bigint>(r, CONTRACTS.robinhood.vibesToken, "totalSupply");
  const reserve = val<bigint>(r, CONTRACTS.robinhood.vibesToken, "balanceOf", [CONTRACTS.robinhood.vibesReserveAdapter]);
  let parity: ParityGlobal | null = null;
  const parityNext: PagerGlobal["parity"] = {
    driftSince: prevParity?.driftSince ?? null,
    lastDelta: prevParity?.lastDelta ?? null,
    lastSpreadBps: prevParity?.lastSpreadBps ?? null,
  };
  if (b && r && locked !== undefined && supply !== undefined && reserve !== undefined) {
    const circulating = supply - reserve;
    const delta = locked - circulating;
    const driftSince = delta > 0n ? (prevParity?.driftSince ?? now) : null;
    parity = { locked, circulating, delta, driftSince, baseBlock: b.block.number.toString(), rhBlock: r.block.number.toString() };
    parityNext.driftSince = driftSince;
    parityNext.lastDelta = delta.toString();
  }

  // VIBES per WETH on each venue (token0 = WETH, token1 = VIBES on both pools; both 18 decimals)
  const reserves = val<readonly [bigint, bigint, bigint]>(b, CONTRACTS.base.vibesAerodromePool, "getReserves");
  const slot0 = val<readonly [bigint, number]>(r, CONTRACTS.robinhood.vibesUniswapV3Pool, "slot0");
  const baseP = reserves ? v2PricesScaled18(reserves[0], reserves[1], 18, 18).token1PerToken0 : 0n;
  const rhP = slot0 ? v3PricesScaled18(slot0[0], 18, 18).token1PerToken0 : 0n;
  const spreadBps = baseP > 0n && rhP > 0n ? Number(((rhP - baseP) * 10_000n) / baseP) : null;
  const baseFee = val<bigint>(b, CONTRACTS.base.aerodromeFactory, "getFee", [CONTRACTS.base.vibesAerodromePool, false]);
  const rhFee = val<number | bigint>(r, CONTRACTS.robinhood.vibesUniswapV3Pool, "fee");
  const feeDragBps = baseFee !== undefined && rhFee !== undefined ? Number(baseFee) + Number(rhFee) / 100 : null;
  if (spreadBps !== null) parityNext.lastSpreadBps = spreadBps;
  return {
    parity,
    spreadBps,
    cheaperVenue: spreadBps === null || spreadBps === 0 ? null : spreadBps > 0 ? "robinhood" : "base",
    feeDragBps,
    baseVibesPerWeth: baseP > 0n ? baseP.toString() : null,
    rhVibesPerWeth: rhP > 0n ? rhP.toString() : null,
    parityNext,
    parityState: parityNext,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Entry point                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

export function evaluateWatch(ctx: EvalContext, w: Watch, prev: WatchState): { alerts: PagerAlert[]; next: WatchState; observations: RuleObservation[] } {
  const st = structuredClone(prev);
  st.seen ??= [];
  st.cooldownUntil ??= {};
  st.firing ??= {};
  const out: Out = { alerts: [], obs: [] };
  const snap = ctx.snap[w.chainId];
  if (!snap) {
    return { alerts: [], next: markErrored(prev, `${chainName(w.chainId)} RPC probe failed this tick`, ctx.now), observations: [] };
  }
  const rules = w.rules.filter((r) => r.enabled);
  const rule = <K extends RuleType>(t: K) => rules.find((r) => r.type === t) as Extract<RuleConfig, { type: K }> | undefined;
  const seed = !!ctx.seedOnly;

  // Pool sample bookkeeping (before the rules)
  if (w.meta.pool && (rule("lp_liquidity_drop") || rule("price_move"))) {
    const sample = readPoolSample(w, snap, ctx.now);
    if (sample) pushSample(st, sample, Math.max(rule("lp_liquidity_drop")?.windowMin ?? 0, rule("price_move")?.windowMin ?? 0, 60), ctx.now);
  }

  // One faulty log / odd contract response must never kill the whole watch: isolate every step.
  const evalErrors: string[] = [];
  const guard = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      evalErrors.push(`${name}: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`);
    }
  };
  if (!seed) {
    const lp = rule("lp_liquidity_drop");
    if (lp) guard(lp.type, () => lpDrop(ctx, w, st, lp, out));
    const pm = rule("price_move");
    if (pm) guard(pm.type, () => priceMove(ctx, w, st, pm, out));
    const sp = rule("spread_bps");
    if (sp) guard(sp.type, () => spread(ctx, w, st, sp, out));
    const pd = rule("parity_drift");
    if (pd) guard(pd.type, () => parityDrift(ctx, w, st, pd, out));
    const wa = rule("wallet_new_approval");
    if (wa) guard(wa.type, () => newApprovals(ctx, w, st, wa, snap, out));
    const wt = rule("whale_transfer");
    if (wt) guard(wt.type, () => whaleTransfer(ctx, w, st, wt, snap, out));
    const bc = rule("band_change");
    if (bc) observe(out, bc, false, null, st.scan ? `last scan ${st.scan.band} (${st.scan.score}/100)` : "evaluated by the periodic scan pass");
  }

  // State-diff domains: each seeds its baseline when missing and only evaluates rules when not seeding.
  guard("escrow", () => escrowDomain(ctx, w, st, snap, seed ? [] : rules, out));
  guard("wallet", () => walletDomain(ctx, w, st, snap, seed ? undefined : rule("wallet_activity"), out, !!rule("wallet_activity")));
  guard("code", () => codeDomain(ctx, w, st, snap, seed ? undefined : rule("proxy_upgrade"), seed ? undefined : rule("admin_change"), out, !!rule("proxy_upgrade") || !!rule("admin_change")));
  guard("bridge", () => bridgeDomain(ctx, w, st, seed ? undefined : rule("bridge_peer_change"), seed ? undefined : rule("admin_change"), out, seed, !!rule("bridge_peer_change"), !!rule("admin_change")));
  guard("supply", () => supplyDomain(ctx, w, st, snap, seed ? undefined : rule("supply_change"), out, !!rule("supply_change") || !!rule("whale_transfer")));

  st.lastCheckedAt = ctx.now;
  st.lastCheckedBlock = snap.block.number.toString();
  const hardError = snap.errors.find((e) => e.startsWith("multicall"));
  st.lastError = (snap.errors[0] ?? (evalErrors.length ? `evaluation: ${evalErrors[0]}` : null))?.slice(0, 200) ?? null;
  st.consecutiveErrors = hardError ? (prev.consecutiveErrors ?? 0) + 1 : 0;

  const alerts = seed ? [] : out.alerts;
  for (const a of alerts) {
    st.alertCount = (st.alertCount ?? 0) + 1;
    if (a.severity !== "info" || !st.lastAlert) st.lastAlert = { ruleType: a.ruleType, title: a.title, severity: a.severity, at: a.at };
  }
  return { alerts, next: st, observations: out.obs };
}

/* ------------------------------------------------------------------------------------------------ */
/* Pools                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Pool orientation, identical to the scan (engine/pools.ts riskyPrice + sides.ts): the quote side is chosen by
 * ADDRESS (USDC > USDbC > WETH > cbBTC); the risky token is the other side and is priced in the quote token.
 * With no known quote asset, token0 is priced in token1 (q = 1).
 */
function poolOrientation(w: Watch): { q: 0 | 1; quoteKnown: boolean; legacyQ: 0 | 1 } {
  const p = w.meta.pool!;
  const qs = p.quoteSide !== undefined ? p.quoteSide : quoteSideOf(w.chainId, p.token0.address, p.token1.address);
  return { q: qs ?? 1, quoteKnown: qs !== null, legacyQ: p.wethSide === 1 ? 1 : 0 };
}

/** Samples comparable with the current orientation (legacy samples carried the wethSide orientation). */
function orientedSamples(w: Watch, samples: PoolSample[]): PoolSample[] {
  const o = poolOrientation(w);
  return samples.filter((s) => (s.q ?? o.legacyQ) === o.q);
}

/** Dust / thin thresholds in the QUOTE asset's own units (WETH: 0.05 / 0.5, i.e. thin/100 and thin/10). */
function quoteThresholds(w: Watch): { dust: bigint; thin: bigint; symbol: string; decimals: number } | null {
  const p = w.meta.pool!;
  const o = poolOrientation(w);
  if (!o.quoteKnown) return null;
  const quote = o.q === 0 ? p.token0 : p.token1;
  const qa = quoteAssetFor(w.chainId, quote.address);
  return qa ? { dust: qa.thin / 100n, thin: qa.thin / 10n, symbol: qa.symbol, decimals: qa.decimals } : null;
}

export function readPoolSample(w: Watch, snap: ChainSnapshot, now: number): PoolSample | null {
  const pool = w.meta.pool;
  if (!pool) return null;
  const d0 = pool.token0.decimals;
  const d1 = pool.token1.decimals;
  const { q } = poolOrientation(w);
  let liq: bigint, px: bigint, depth: bigint;
  if (pool.kind === "aerodrome-v2") {
    const r = val<readonly [bigint, bigint, bigint]>(snap, pool.address, "getReserves");
    if (!r) return null;
    liq = isqrt(r[0] * r[1]);
    const p = v2PricesScaled18(r[0], r[1], d0, d1);
    // risky side priced in the quote side (q = 0: token1 in token0; q = 1: token0 in token1)
    px = q === 0 ? p.token0PerToken1 : p.token1PerToken0;
    depth = q === 0 ? r[0] : r[1];
  } else {
    const s0 = val<readonly [bigint, number]>(snap, pool.address, "slot0");
    const L = val<bigint>(snap, pool.address, "liquidity");
    if (!s0 || L === undefined) return null;
    liq = L;
    const p = v3PricesScaled18(s0[0], d0, d1);
    px = q === 0 ? p.token0PerToken1 : p.token1PerToken0;
    const vr = v3VirtualReserves(s0[0], L);
    depth = q === 0 ? vr.reserve0 : vr.reserve1;
  }
  return { at: now, block: snap.block.number.toString(), liq: liq.toString(), px: px.toString(), wethDepth: depth.toString(), q };
}

/** Newest-first ring: ≤ 40 samples spaced ≥ (window + 4 min) / 38 apart; the head is always the latest read. */
export function pushSample(st: WatchState, s: PoolSample, windowMin: number, now: number) {
  if (!st.pool) {
    st.pool = { armed: s, samples: [s] };
    return;
  }
  const keepMs = (windowMin + 4) * 60_000;
  const minGap = keepMs / (POOL_SAMPLES_MAX - 2);
  const samples = st.pool.samples;
  if (samples.length >= 2 && samples[0].at - samples[1].at < minGap) samples[0] = s; // head not yet committed
  else samples.unshift(s);
  st.pool.samples = samples.filter((x, i) => i === 0 || x.at >= now - keepMs).slice(0, POOL_SAMPLES_MAX);
}

function poolNames(w: Watch) {
  const p = w.meta.pool!;
  const { q } = poolOrientation(w);
  const risky = q === 0 ? p.token1 : p.token0;
  const quote = q === 0 ? p.token0 : p.token1;
  const venue = p.kind === "uniswap-v3" ? `${chainName(w.chainId)} Uniswap v3` : p.kind === "aerodrome-cl" ? "Aerodrome Slipstream" : "Aerodrome";
  return { risky, quote, venue, pair: `${p.token0.symbol}/${p.token1.symbol}` };
}

function lpDrop(ctx: EvalContext, w: Watch, st: WatchState, r: Extract<RuleConfig, { type: "lp_liquidity_drop" }>, out: Out) {
  const pool = w.meta.pool;
  const samples = pool ? orientedSamples(w, (st.pool?.samples ?? []).filter((s) => s.at >= ctx.now - r.windowMin * 60_000)) : [];
  const qt = pool ? quoteThresholds(w) : null;
  const cur = samples[0];
  if (!pool || !cur || samples.length < 2 || cur.at !== ctx.now) {
    observe(out, r, false, null, cur && cur.at === ctx.now ? "collecting samples" : "pool read unavailable this tick");
    return;
  }
  const peakS = samples.reduce((m, s) => (BigInt(s.liq) > BigInt(m.liq) ? s : m), samples[0]);
  const peak = BigInt(peakS.liq);
  const now = BigInt(cur.liq);
  const d = dropBps(peak, now);
  const observed = `liquidity ${d > 0 ? "−" : ""}${pctStr(d)} vs ${r.windowMin}-min peak`;
  if (qt && BigInt(peakS.wethDepth) < qt.dust) {
    observe(out, r, false, null, `${observed} · dust pool (< ${fmtUnits(qt.dust, qt.decimals, 4)} ${qt.symbol}) ignored`);
    return;
  }
  if (d < r.dropBps) {
    if (now * 10n >= peak * 9n) st.firing[r.id] = false; // re-arm at ≥ 90% of peak
    observe(out, r, false, null, observed);
    return;
  }
  if (st.firing[r.id] || cooling(st, r, ctx.now)) {
    observe(out, r, false, null, `${observed} · already alerted (hysteresis/cooldown)`);
    return;
  }
  const snap = ctx.snap[w.chainId]!;
  const burns = snap.logs.burns.filter((l) => l.address.toLowerCase() === pool.address.toLowerCase());
  const n = poolNames(w);
  let sev: Severity = d >= 4000 ? "critical" : "warn";
  let what = "pulled";
  const isCL = pool.kind !== "aerodrome-v2"; // Uniswap v3 or Aerodrome Slipstream: concentrated liquidity
  if (burns.length === 0 && isCL) {
    sev = "warn";
    what = snap.logsOk ? "left the active range" : "dropped (Burn logs unavailable)";
  }
  const key = `lp:${cur.block}`;
  st.firing[r.id] = true;
  startCooldown(st, r, ctx.now);
  if (!fire(st, key)) return observe(out, r, false, null, observed);
  const depthLine = qt ? ` · ${qt.symbol} depth ${fmtUnits(peakS.wethDepth, qt.decimals, 3)} → ${fmtUnits(cur.wethDepth, qt.decimals, 3)}` : "";
  out.alerts.push(
    mkAlert(ctx, w, r, sev, `LP ${what} on ${n.pair} (${n.venue}): liquidity −${pctStr(d)} in ${minutes(cur.at - peakS.at)} min`, [
      `${w.label}: ${isCL ? "active liquidity L" : "pool √k (swaps barely move it; LP removals do)"} −${pctStr(d)} vs the ${r.windowMin}-min peak${depthLine}`,
      burns.length ? `${burns.length} Burn event${burns.length > 1 ? "s" : ""} on the pool in this window` : isCL ? "No Burn event in this window: price likely moved out of concentrated ranges" : "",
      `Block #${cur.block}`,
    ], key, { txHash: burns[0]?.transactionHash ?? null, evidenceAddress: pool.address })
  );
  observe(out, r, true, sev, observed);
}

function priceMove(ctx: EvalContext, w: Watch, st: WatchState, r: Extract<RuleConfig, { type: "price_move" }>, out: Out) {
  const pool = w.meta.pool;
  // Only samples with the SAME orientation are compared (a flipped orientation would read as a huge move).
  const samples = pool ? orientedSamples(w, (st.pool?.samples ?? []).filter((s) => s.at >= ctx.now - r.windowMin * 60_000)) : [];
  const qt = pool ? quoteThresholds(w) : null;
  const cur = samples[0];
  const old = samples[samples.length - 1];
  if (!pool || !cur || samples.length < 2 || cur.at !== ctx.now || BigInt(old.px) === 0n) {
    observe(out, r, false, null, cur && cur.at === ctx.now ? "collecting samples" : "pool read unavailable this tick");
    return;
  }
  const mv = changeBps(BigInt(old.px), BigInt(cur.px));
  const observed = `${fmtBps(mv)} over ${minutes(cur.at - old.at)} min`;
  if (qt && BigInt(cur.wethDepth) < qt.thin) {
    observe(out, r, false, null, `${observed} · thin pool (< ${fmtUnits(qt.thin, qt.decimals, 4)} ${qt.symbol}) ignored`);
    return;
  }
  if (Math.abs(mv) < r.moveBps) {
    if (Math.abs(mv) < r.moveBps / 2) st.firing[r.id] = false;
    observe(out, r, false, null, observed);
    return;
  }
  if (st.firing[r.id] || cooling(st, r, ctx.now)) {
    observe(out, r, false, null, `${observed} · already alerted (hysteresis/cooldown)`);
    return;
  }
  const key = `px:${cur.block}`;
  st.firing[r.id] = true;
  startCooldown(st, r, ctx.now);
  if (!fire(st, key)) return observe(out, r, false, null, observed);
  const n = poolNames(w);
  const sev: Severity = Math.abs(mv) >= 5000 ? "critical" : "warn";
  out.alerts.push(
    mkAlert(ctx, w, r, sev, `${n.risky.symbol} ${fmtBps(mv)} in ${minutes(cur.at - old.at)} min on ${n.venue}`, [
      `${fmtUnits(old.px, 18, 10)} → ${fmtUnits(cur.px, 18, 10)} ${n.quote.symbol} per ${n.risky.symbol}`,
      qt ? `${qt.symbol} depth now ${fmtUnits(cur.wethDepth, qt.decimals, 3)}` : "",
      `Block #${cur.block}`,
    ], key, { evidenceAddress: pool.address })
  );
  observe(out, r, true, sev, observed);
}

/* ------------------------------------------------------------------------------------------------ */
/* $VIBES globals: spread + parity                                                                   */
/* ------------------------------------------------------------------------------------------------ */

function spread(ctx: EvalContext, w: Watch, st: WatchState, r: Extract<RuleConfig, { type: "spread_bps" }>, out: Out) {
  const g = ctx.globals;
  if (g.spreadBps === null) return observe(out, r, false, null, "spread unavailable (a pool read failed)");
  const abs = Math.abs(g.spreadBps);
  const observed = `${fmtBps(g.spreadBps)}${g.cheaperVenue ? ` (cheaper on ${g.cheaperVenue === "robinhood" ? "Robinhood" : "Base"})` : ""}`;
  if (abs <= r.maxBps) {
    if (abs < r.maxBps * 0.8) st.firing[r.id] = false;
    return observe(out, r, false, null, observed);
  }
  if (st.firing[r.id] || cooling(st, r, ctx.now)) return observe(out, r, false, null, `${observed} · already alerted (hysteresis/cooldown)`);
  st.firing[r.id] = true;
  startCooldown(st, r, ctx.now);
  const block = ctx.snap[8453]?.block.number.toString() ?? "0";
  const key = `spread:${block}`;
  if (!fire(st, key)) return observe(out, r, false, null, observed);
  const net = g.feeDragBps !== null ? abs - g.feeDragBps : null;
  out.alerts.push(
    mkAlert(ctx, w, r, "warn", `Base↔Robinhood VIBES spread ${observed}`, [
      net !== null ? `Net of ${g.feeDragBps} bps pool fees: ${fmtBps(net)} before gas & LayerZero fee` : "Pool fees unavailable this tick",
      g.baseVibesPerWeth && g.rhVibesPerWeth ? `VIBES per WETH: Base ${fmtUnits(g.baseVibesPerWeth, 18, 2)} · Robinhood ${fmtUnits(g.rhVibesPerWeth, 18, 2)}` : "",
      "Robinhood v3 reflects the last quote in the active range, not necessarily a recent trade",
    ], key, { chainId: 8453, block, evidenceAddress: CONTRACTS.base.vibesAerodromePool })
  );
  observe(out, r, true, "warn", observed);
}

function parityDrift(ctx: EvalContext, w: Watch, st: WatchState, r: Extract<RuleConfig, { type: "parity_drift" }>, out: Out) {
  const p = ctx.globals.parity;
  if (!p) return observe(out, r, false, null, "parity unavailable (a Base or Robinhood read failed)");
  const kPending = `${r.id}:unbacked1`;
  const kUnbacked = `${r.id}:unbacked`;
  const kDrift = `${r.id}:drift`;
  const absDelta = p.delta < 0n ? -p.delta : p.delta;
  const facts = `Base locked ${fmtUnits(p.locked, 18, 2)} · RH circulating ${fmtUnits(p.circulating, 18, 2)} VIBES (Base #${p.baseBlock} · RH #${p.rhBlock})`;
  const ev = { chainId: 4663 as ChainId, block: p.rhBlock, evidenceAddress: CONTRACTS.robinhood.vibesToken };

  if (p.delta < 0n) {
    // circulating > locked is never produced by the bridge itself: unbacked supply. Two consecutive checks filter read skew.
    const observed = `UNBACKED: RH circulating exceeds Base locked by ${fmtUnits(absDelta, 18, 2)} VIBES`;
    if (!st.firing[kPending]) {
      st.firing[kPending] = true;
      return observe(out, r, false, null, `${observed} (awaiting 2nd consecutive check)`);
    }
    if (st.firing[kUnbacked]) return observe(out, r, false, null, `${observed} · already alerted`);
    st.firing[kUnbacked] = true;
    const key = `parity:unbacked:${p.rhBlock}`;
    if (fire(st, key)) {
      st.unbackedAlertId = alertId(w.id, key); // the recovery alert resolves THIS id (its key carries the block)
      out.alerts.push(mkAlert(ctx, w, r, "critical", `UNBACKED $VIBES on Robinhood: circulating exceeds Base locked by ${fmtUnits(absDelta, 18, 2)} VIBES`, [
        facts,
        "In-flight OFT transfers only ever make locked > circulating; the reverse means supply exists without backing",
      ], key, ev));
      return observe(out, r, true, "critical", observed);
    }
    return observe(out, r, false, null, observed);
  }
  st.firing[kPending] = false;
  if (st.firing[kUnbacked]) {
    st.firing[kUnbacked] = false;
    const key = `parity:unbacked-resolved:${p.rhBlock}`;
    if (fire(st, key)) out.alerts.push(mkAlert(ctx, w, r, "info", "RESOLVED: $VIBES backing restored on Robinhood", [facts], key, { ...ev, ...(st.unbackedAlertId ? { resolves: st.unbackedAlertId } : {}) }));
    delete st.unbackedAlertId;
  }

  if (p.delta === 0n) {
    if (st.firing[kDrift]) {
      st.firing[kDrift] = false;
      const key = `parity:resolved:${p.rhBlock}`;
      if (fire(st, key)) {
        out.alerts.push(mkAlert(ctx, w, r, "info", "RESOLVED: OFT parity exact again (Δ 0)", [facts], key, ev));
        return observe(out, r, true, "info", "exact (Δ 0) · drift episode resolved");
      }
    }
    return observe(out, r, false, null, "exact (Δ 0)");
  }

  // locked > circulating: in flight (normal for minutes) or stuck
  const since = p.driftSince ?? ctx.now;
  const age = ctx.now - since;
  const observed = `IN_FLIGHT/locked > circulating by ${fmtUnits(absDelta, 18, 2)} VIBES for ${fmtDuration(Math.floor(age / 1000))}`;
  let sev: Severity | null = null;
  let key = "";
  if (age >= 60 * 60_000) {
    sev = "critical";
    key = `parity:drift:${since}:crit`;
  } else if (age >= r.persistMin * 60_000) {
    sev = "warn";
    key = `parity:drift:${since}:warn`;
  }
  if (!sev || !fire(st, key)) return observe(out, r, false, null, observed);
  st.firing[kDrift] = true;
  out.alerts.push(
    mkAlert(ctx, w, r, sev, `OFT parity drift for ${minutes(age)} min: Base locked exceeds RH circulating by ${fmtUnits(absDelta, 18, 2)} VIBES`, [
      facts,
      sev === "critical" ? "Persisting > 60 min: a packet may be stuck (e.g. RateLimitExceeded at the destination). Anyone can retry a verified packet via EndpointV2.lzReceive." : "Likely an in-flight bridge transfer; escalates to CRITICAL at 60 min.",
    ], key, ev)
  );
  observe(out, r, true, sev, observed);
}

/* ------------------------------------------------------------------------------------------------ */
/* Escrow                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

const CAMPAIGN_STATES = ["Uninitialized", "Active", "Paused", "Funded", "Failed", "Frozen", "Refunding", "Completed"];
const CHALLENGE_STATES = ["None", "Pending", "Upheld", "Rejected"];
const trancheLabel = (i: number) => (i === 0 ? "Kickstart" : `Month ${i}`);
const trancheBps = (i: number) => (i === 0 ? 1000 : 1500);

interface EscrowNow {
  state: number;
  nextTranche: number;
  oracle: number;
  window: number;
  requestedAt: number[];
  claimed: boolean[];
  challenged: boolean[];
  unlock: number[];
  amount: bigint[];
  challenge: { challenger: string; reason: string; tranche: number; timestamp: number; state: number } | null;
}

function readEscrowNow(w: Watch, snap: ChainSnapshot): EscrowNow | null {
  const a = w.target;
  const c = val<{ nextTranche: number; state: number }>(snap, a, "getCampaign");
  if (!c) return null;
  const ch = val<{ challenger: string; reason: string; tranche: bigint; timestamp: bigint; state: number }>(snap, a, "getActiveChallenge");
  const n: EscrowNow = {
    state: Number(c.state),
    nextTranche: Number(c.nextTranche),
    oracle: Number(val<bigint>(snap, a, "getCurrentTime") ?? BigInt(snap.block.timestamp)),
    window: Number(val<bigint>(snap, a, "CHALLENGE_WINDOW") ?? 259_200n),
    requestedAt: [],
    claimed: [],
    challenged: [],
    unlock: [],
    amount: [],
    challenge: ch ? { challenger: ch.challenger, reason: String(ch.reason).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200), tranche: Number(ch.tranche), timestamp: Number(ch.timestamp), state: Number(ch.state) } : null,
  };
  for (let i = 0; i < NUM_TRANCHES; i++) {
    const req = val<bigint>(snap, a, "trancheRequestedAt", [i]);
    const cl = val<boolean>(snap, a, "trancheClaimed", [i]);
    const chd = val<boolean>(snap, a, "trancheChallenged", [i]);
    if (req === undefined || cl === undefined || chd === undefined) return null; // partial read: never guess
    n.requestedAt.push(Number(req));
    n.claimed.push(cl);
    n.challenged.push(chd);
    n.unlock.push(Number(val<bigint>(snap, a, "getTrancheUnlockTime", [i]) ?? 0n));
    n.amount.push(val<bigint>(snap, a, "getTrancheAmount", [i]) ?? 0n);
  }
  return n;
}

function escrowDomain(ctx: EvalContext, w: Watch, st: WatchState, snap: ChainSnapshot, rules: RuleConfig[], out: Out) {
  if (w.kind !== "escrow") return;
  const escrowRules = rules.filter((r) => r.type.startsWith("escrow_"));
  const now = readEscrowNow(w, snap);
  if (!now) {
    for (const r of escrowRules) observe(out, r, false, null, "escrow read unavailable this tick");
    return;
  }
  const prev = st.escrow;
  const marksFired: Record<string, number[]> = { ...(prev?.marksFired ?? {}) };
  const openIdx = now.requestedAt.map((req, i) => (req > 0 && !now.claimed[i] && now.oracle < req + now.window ? i : -1)).filter((i) => i >= 0);
  // Reset marks for tranches whose request changed (re-request after a challenge)
  for (let i = 0; i < NUM_TRANCHES; i++) if (prev && prev.requestedAt[i] !== now.requestedAt[i]) delete marksFired[String(i)];
  const amt = (i: number) => `${fmtUnits(now.amount[i], 18, 3)} ETH`;

  if (prev) {
    for (const r of escrowRules) {
      if (r.type === "escrow_window_opened") {
        let fired = false;
        for (const i of openIdx) {
          if (prev.requestedAt[i] === now.requestedAt[i]) continue;
          const end = now.requestedAt[i] + now.window;
          const key = `esc:${i}:${now.requestedAt[i]}:open`;
          if (!fire(st, key)) continue;
          fired = true;
          out.alerts.push(mkAlert(ctx, w, r, "critical", `${w.label}: founder requested ${trancheLabel(i)} (${trancheBps(i) / 100}% · ${amt(i)})`, [
            `72h backer challenge window open until ${fmtUtc(end)} (${fmtDuration(end - now.oracle)} left)`,
            "Backers can review the founder's progress and file a challenge before the window closes",
          ], key));
        }
        observe(out, r, fired, fired ? "critical" : null, openIdx.length ? `${openIdx.length} window(s) open` : "no open challenge window");
      } else if (r.type === "escrow_window_closing") {
        let fired = false;
        const marks = [...r.marksHours].sort((a, b) => b - a);
        for (const i of openIdx) {
          const end = now.requestedAt[i] + now.window;
          const left = end - now.oracle;
          const done = new Set(marksFired[String(i)] ?? []);
          const crossed = marks.filter((m) => left <= m * 3600 && !done.has(m));
          if (!crossed.length) continue;
          marksFired[String(i)] = [...done, ...crossed].sort((a, b) => b - a);
          const m = crossed[crossed.length - 1];
          const key = `esc:${i}:${now.requestedAt[i]}:mark:${m}`;
          if (!fire(st, key)) continue;
          fired = true;
          out.alerts.push(mkAlert(ctx, w, r, "warn", `Challenge window for ${w.label} ${trancheLabel(i)} closes in ${fmtDuration(left)}`, [
            `Closes ${fmtUtc(end)} · tranche ${trancheBps(i) / 100}% (${amt(i)})`,
          ], key));
        }
        observe(out, r, fired, fired ? "warn" : null, openIdx.length ? openIdx.map((i) => `${trancheLabel(i)}: ${fmtDuration(now.requestedAt[i] + now.window - now.oracle)} left`).join(" · ") : "no open challenge window");
      } else if (r.type === "escrow_unlock_soon") {
        const i = now.nextTranche;
        let observed = "no upcoming tranche";
        let fired = false;
        if (i < NUM_TRANCHES && now.requestedAt[i] === 0 && now.unlock[i] > 0) {
          const dt = now.unlock[i] - now.oracle;
          observed = dt > 0 ? `${trancheLabel(i)} unlocks in ${fmtDuration(dt)}` : `${trancheLabel(i)} unlocked, not yet requested`;
          const key = `esc:${i}:unlock:${now.unlock[i]}`;
          if (dt > 0 && dt <= r.leadHours * 3600 && fire(st, key)) {
            fired = true;
            out.alerts.push(mkAlert(ctx, w, r, "info", `${w.label} ${trancheLabel(i)} unlocks in ${fmtDuration(dt)} (${fmtUtc(now.unlock[i])})`, [
              `${trancheBps(i) / 100}% tranche (${amt(i)}); a 72h backer challenge window follows the founder's request`,
            ], key));
          }
        }
        observe(out, r, fired, fired ? "info" : null, observed);
      } else if (r.type === "escrow_challenge_or_state") {
        let fired: Severity | null = null;
        const ch = now.challenge;
        if (ch && ch.state !== 0 && (ch.timestamp !== prev.challengeTs || ch.state !== prev.challengeState)) {
          const isNew = ch.timestamp !== prev.challengeTs && ch.state === 1;
          const sev: Severity = isNew ? "critical" : ch.state === 1 ? "critical" : "warn";
          const key = `esc:ch:${ch.timestamp}:${ch.state}`;
          if (fire(st, key)) {
            fired = sev;
            out.alerts.push(mkAlert(ctx, w, r, sev, isNew || ch.state === 1 ? `Backer challenge filed on ${w.label} ${trancheLabel(ch.tranche)} by ${shortAddr(ch.challenger)}` : `Backer challenge on ${w.label} ${trancheLabel(ch.tranche)} ${CHALLENGE_STATES[ch.state] ?? `state ${ch.state}`}`, [
              ch.reason ? `Reason: "${ch.reason}"` : "",
              `Filed ${fmtUtc(ch.timestamp)} · status ${CHALLENGE_STATES[ch.state] ?? ch.state}`,
            ], key));
          }
        }
        if (now.state !== prev.state) {
          const sev: Severity = now.state === 4 || now.state === 5 || now.state === 6 ? "critical" : now.state === 7 ? "info" : "warn";
          const key = `esc:state:${now.state}`;
          if (fire(st, key)) {
            fired = fired ?? sev;
            out.alerts.push(mkAlert(ctx, w, r, sev, `${w.label}: campaign state ${CAMPAIGN_STATES[prev.state] ?? prev.state} → ${CAMPAIGN_STATES[now.state] ?? now.state}`, [
              now.state === 6 ? "Refunding: backers should claim refunds" : now.state === 4 ? "Failed: the raise did not complete" : now.state === 5 ? "Frozen: tranche releases are halted" : "",
            ], key));
          }
        }
        observe(out, r, !!fired, fired, `state ${CAMPAIGN_STATES[now.state] ?? now.state} · challenge ${ch && ch.state ? CHALLENGE_STATES[ch.state] : "none"}`);
      }
    }
  } else {
    for (const r of escrowRules) observe(out, r, false, null, "baseline recorded");
  }

  st.escrow = {
    state: now.state,
    nextTranche: now.nextTranche,
    requestedAt: now.requestedAt,
    claimed: now.claimed,
    challenged: now.challenged,
    challengeTs: now.challenge?.timestamp ?? 0,
    challengeState: now.challenge?.state ?? 0,
    marksFired,
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Wallets                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

interface DecodedApproval {
  kind: "erc20" | "erc721" | "forall" | "permit2";
  token: string;
  spender: string;
  amount: bigint; // erc721/forall: 1 = granted, 0 = revoked
  unlimited: boolean;
  expiration?: number;
}

export function decodeApproval(l: { address: string; topics: readonly (string | null)[]; data: string }): DecodedApproval | null {
  const t0 = l.topics[0];
  try {
    if (t0 === T.ERC20_APPROVAL && l.topics.length === 3) {
      const spender = topicAddr(l.topics[2] ?? undefined);
      if (!spender) return null;
      const [amount] = decodeAbiParameters([{ type: "uint256" }], l.data as Hex);
      return { kind: "erc20", token: l.address.toLowerCase(), spender, amount, unlimited: amount >= UNLIMITED_THRESHOLD };
    }
    if (t0 === T.ERC20_APPROVAL && l.topics.length === 4) {
      const spender = topicAddr(l.topics[2] ?? undefined);
      if (!spender) return null;
      return { kind: "erc721", token: l.address.toLowerCase(), spender, amount: spender === ZERO ? 0n : 1n, unlimited: false };
    }
    if (t0 === T.APPROVAL_FOR_ALL && l.topics.length === 3) {
      const spender = topicAddr(l.topics[2] ?? undefined);
      if (!spender) return null;
      const [approved] = decodeAbiParameters([{ type: "bool" }], l.data as Hex);
      return { kind: "forall", token: l.address.toLowerCase(), spender, amount: approved ? 1n : 0n, unlimited: approved };
    }
    if ((t0 === T.PERMIT2_APPROVAL || t0 === T.PERMIT2_PERMIT) && l.topics.length === 4) {
      if (l.address.toLowerCase() !== PERMIT2.toLowerCase()) return null; // only the real Permit2 emits these
      const token = topicAddr(l.topics[2] ?? undefined);
      const spender = topicAddr(l.topics[3] ?? undefined);
      if (!token || !spender) return null;
      const [amount, expiration] = decodeAbiParameters([{ type: "uint160" }, { type: "uint48" }], `0x${l.data.replace(/^0x/, "").slice(0, 128)}` as Hex);
      return { kind: "permit2", token, spender, amount, unlimited: amount >= UNLIMITED_THRESHOLD, expiration: Number(expiration) };
    }
  } catch {
    return null;
  }
  return null;
}

function newApprovals(ctx: EvalContext, w: Watch, st: WatchState, r: Extract<RuleConfig, { type: "wallet_new_approval" }>, snap: ChainSnapshot, out: Out) {
  if (!snap.logsOk) return observe(out, r, false, null, "approval logs unavailable this tick (RPC error); will retry the window next tick only if the cursor is held");
  const owner = w.target.toLowerCase();
  st.wallet ??= { balance: "0", nonce: null, openApprovals: {} };
  st.wallet.openApprovals ??= {};
  const known = new Map(SPENDERS[w.chainId].map((s) => [s.address.toLowerCase(), s.name]));
  let count = 0;
  let consumed = 0;
  let worst: Severity | null = null;
  const logs = snap.logs.approvals.filter((l) => topicAddr(l.topics[1] ?? undefined) === owner);
  for (const l of logs) {
    const d = decodeApproval(l);
    if (!d) continue;
    const key = `${l.transactionHash}:${l.logIndex}`;
    const pairKey = `${d.token}:${d.spender}`;
    const tok = snap.tokenInfo(d.token);
    const sym = tok?.symbol ?? shortAddr(d.token);
    const spenderName = known.get(d.spender) ?? KNOWN_LABELS[d.spender] ?? null;
    const spenderTxt = spenderName ? `${spenderName} (${shortAddr(d.spender)})` : `unknown spender ${shortAddr(d.spender)}`;
    const ev = { txHash: l.transactionHash, block: l.blockNumber?.toString() };
    if (d.amount === 0n) {
      const open = st.wallet.openApprovals[pairKey];
      if (open && fire(st, key)) {
        delete st.wallet.openApprovals[pairKey];
        out.alerts.push(mkAlert(ctx, w, r, "info", `RESOLVED: approval revoked on watched wallet ${shortAddr(w.target)}`, [`${sym} → ${spenderTxt} is now 0`], key, { ...ev, resolves: open.alertId }));
      }
      continue;
    }
    if (d.kind === "erc20") {
      const live = snap.allowance(d.token, owner, d.spender);
      if (live === 0n) {
        consumed++; // allowance already 0: spent/revoked inside this window, or a spoofed event from a fake token
        continue;
      }
    }
    const isKnown = known.has(d.spender);
    const sev: Severity | null = d.kind === "forall" || d.kind === "erc721" || d.unlimited || !isKnown ? "critical" : r.knownSpenders === "ignore" ? null : "warn";
    if (!sev || count >= 10 || !fire(st, key)) continue;
    count++;
    const amountTxt =
      d.kind === "forall" ? "ALL tokens (setApprovalForAll)" :
      d.kind === "erc721" ? "an NFT (ERC-721 approve)" :
      d.unlimited ? "UNLIMITED" :
      tok ? `${fmtUnits(d.amount, tok.decimals, 4)} ${sym}` : `${d.amount.toString()} raw units`;
    const spenderShort = spenderName ? spenderName : "unknown spender " + shortAddr(d.spender);
    const title =
      d.kind === "forall" ? `Watched wallet ${shortAddr(w.target)} approved ALL of collection ${sym} to ${spenderShort}` :
      d.kind === "erc721" ? `Watched wallet ${shortAddr(w.target)} approved an NFT of ${sym} to ${spenderShort}` :
      `Watched wallet ${shortAddr(w.target)} approved ${d.unlimited ? "UNLIMITED " : ""}${sym} to ${spenderShort}`;
    const a = mkAlert(ctx, w, r, sev, title, [
      `${d.kind === "permit2" ? "Permit2 allowance" : d.kind === "erc20" ? "ERC-20 allowance" : "NFT approval"}: ${amountTxt} → ${spenderTxt}`,
      d.kind === "permit2" && d.expiration ? `Permit2 expiry ${d.expiration > 32_503_680_000 ? "never" : fmtUtc(d.expiration)}` : "",
      `Block #${l.blockNumber?.toString() ?? snap.block.number.toString()}`,
      sev === "critical" ? "If this wasn't you, revoke it now." : "",
    ], key, { ...ev, actions: ctx.links ? ctx.links(w, d.kind === "erc20" ? { revoke: `${d.token}:${d.spender}` } : {}) : watchActions(w, d.kind === "erc20" ? { revoke: `${d.token}:${d.spender}` } : {}) });
    st.wallet.openApprovals[pairKey] = { alertId: a.id, at: ctx.now };
    out.alerts.push(a);
    if (sev === "critical" || !worst) worst = sev;
  }
  // keep the open-approval map bounded
  const entries = Object.entries(st.wallet.openApprovals).sort((x, y) => y[1].at - x[1].at).slice(0, 50);
  st.wallet.openApprovals = Object.fromEntries(entries);
  observe(out, r, count > 0, worst, `${logs.length} approval event(s) in blocks #${snap.range.from}–#${snap.range.to}${count ? ` · ${count} alerted` : ""}${consumed ? ` · ${consumed} skipped (live allowance already 0)` : ""}`);
}

function walletDomain(ctx: EvalContext, w: Watch, st: WatchState, snap: ChainSnapshot, r: Extract<RuleConfig, { type: "wallet_activity" }> | undefined, out: Out, active: boolean) {
  if (w.kind !== "wallet" || !active) return;
  const bal = val<bigint>(snap, MULTICALL3, "getEthBalance", [w.target]);
  const nonce = snap.nonce(w.target);
  const prev = st.wallet;
  if (!prev || prev.nonce === null || bal === undefined) {
    st.wallet = { balance: bal !== undefined ? bal.toString() : (prev?.balance ?? "0"), nonce: nonce ?? prev?.nonce ?? null, openApprovals: prev?.openApprovals ?? {} };
    if (r) observe(out, r, false, null, bal === undefined ? "balance read unavailable" : "baseline recorded");
    return;
  }
  const prevBal = BigInt(prev.balance);
  const observedBal = bal !== prevBal ? ` · balance ${fmtUnits(prevBal, 18, 6)} → ${fmtUnits(bal, 18, 6)} ETH` : "";
  if (r) {
    if (nonce !== null && nonce > prev.nonce) {
      const n = nonce - prev.nonce;
      const key = `${w.target.toLowerCase()}:nonce:${nonce}`;
      const quiet = cooling(st, r, ctx.now);
      if (!quiet && fire(st, key)) {
        startCooldown(st, r, ctx.now);
        out.alerts.push(mkAlert(ctx, w, r, "warn", `Outgoing activity from watched wallet ${shortAddr(w.target)}: nonce ${prev.nonce} → ${nonce} (${n} tx${n > 1 ? "s" : ""})`, [
          `Since the previous check${st.lastCheckedAt ? ` at ${new Date(st.lastCheckedAt).toISOString().slice(11, 16)} UTC` : ""}${observedBal}`,
          "If this wasn't you, open the Panic Bunker.",
          `Further transactions within ${r.cooldownMin ?? 10} min are not re-paged`,
        ], key));
        observe(out, r, true, "warn", `nonce ${prev.nonce} → ${nonce}${observedBal}`);
      } else observe(out, r, false, null, `nonce ${prev.nonce} → ${nonce}${quiet ? " (cooldown)" : ""}${observedBal}`);
    } else {
      observe(out, r, false, null, `nonce ${nonce ?? prev.nonce}${observedBal || " · balance unchanged"}${observedBal ? " (incoming only: digest line)" : ""}`);
    }
  }
  st.wallet = { balance: bal.toString(), nonce: nonce ?? prev.nonce, openApprovals: prev.openApprovals ?? {} };
}

/* ------------------------------------------------------------------------------------------------ */
/* Code: Upgrade Tripwire + admin / owner / Safe / paused                                            */
/* ------------------------------------------------------------------------------------------------ */

export function selectorName(sel: string): string {
  if (sel === OP_SELFDESTRUCT) return "SELFDESTRUCT opcode";
  return RISKY_SELECTORS.find((x) => x.selector === sel)?.signature ?? `0x${sel}`;
}

/** Diff two risky selector sets; returns human signatures. */
export function diffSelectors(before: string[], after: string[]) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)).map(selectorName), removed: before.filter((x) => !a.has(x)).map(selectorName) };
}

function rawSlot(snap: ChainSnapshot, target: string, name: keyof typeof SLOTS): { read: boolean; addr: string | null } {
  const raw = snap.slot(target, SLOTS[name]);
  return raw === null ? { read: false, addr: null } : { read: true, addr: lc(parseAddressFromSlot(raw)) };
}

function codeDomain(
  ctx: EvalContext,
  w: Watch,
  st: WatchState,
  snap: ChainSnapshot,
  up: Extract<RuleConfig, { type: "proxy_upgrade" }> | undefined,
  adm: Extract<RuleConfig, { type: "admin_change" }> | undefined,
  out: Out,
  active: boolean
) {
  const proxy = w.meta.proxy;
  if (!proxy || !active) return;
  const has = (n: (typeof proxy.slots)[number]) => proxy.slots.includes(n);
  const impl = has("eip1967Impl") ? rawSlot(snap, w.target, "eip1967Impl") : null;
  const ozImpl = has("ozImpl") ? rawSlot(snap, w.target, "ozImpl") : null;
  const beacon = has("eip1967Beacon") ? rawSlot(snap, w.target, "eip1967Beacon") : null;
  const admin = has("eip1967Admin") ? rawSlot(snap, w.target, "eip1967Admin") : null;
  const ozAdmin = has("ozAdmin") ? rawSlot(snap, w.target, "ozAdmin") : null;
  const ownerRaw = proxy.hasOwnerFn ? val<string>(snap, w.target, "owner") : undefined;
  const paused = val<boolean>(snap, w.target, "paused");
  const thr = proxy.safe ? val<bigint>(snap, proxy.safe, "getThreshold") : undefined;
  const owners = proxy.safe ? val<readonly string[]>(snap, proxy.safe, "getOwners") : undefined;
  const safeNow = thr !== undefined && owners ? { threshold: Number(thr), owners: owners.map((o) => o.toLowerCase()).sort() } : null;
  const implCode = (addr: string | null) => (addr ? (ctx.newImplCode?.[addr] ?? (ctx.newImplSelectors?.[addr] ? { address: addr, isContract: true, byteSize: 0, selectors: ctx.newImplSelectors[addr] } : undefined)) : undefined);

  const prev = st.code;
  if (!prev) {
    const logic = beacon?.addr ?? impl?.addr ?? ozImpl?.addr ?? null;
    st.code = {
      impl: impl?.addr ?? null,
      admin: admin?.addr ?? null,
      beacon: beacon?.addr ?? null,
      ozImpl: ozImpl?.addr ?? null,
      ozAdmin: ozAdmin?.addr ?? null,
      owner: ownerRaw !== undefined ? ownerRaw.toLowerCase() : null,
      selectors: implCode(logic)?.selectors ?? [],
      safe: safeNow,
      ...(paused !== undefined ? { paused } : {}),
    };
    if (up) observe(out, up, false, null, "baseline recorded");
    if (adm) observe(out, adm, false, null, "baseline recorded");
    return;
  }
  const code = { ...prev };

  // --- Upgrade Tripwire
  if (up) {
    const changes: { slot: "impl" | "ozImpl" | "beacon"; from: string | null; to: string | null }[] = [];
    if (impl?.read && impl.addr !== prev.impl) changes.push({ slot: "impl", from: prev.impl, to: impl.addr });
    if (ozImpl?.read && ozImpl.addr !== prev.ozImpl) changes.push({ slot: "ozImpl", from: prev.ozImpl, to: ozImpl.addr });
    if (beacon?.read && beacon.addr !== prev.beacon) changes.push({ slot: "beacon", from: prev.beacon, to: beacon.addr });
    const unread = [impl, ozImpl, beacon].some((x) => x && !x.read);
    if (!changes.length) {
      observe(out, up, false, null, unread ? "implementation slot read unavailable this tick" : `implementation unchanged (${shortAddr(prev.beacon ?? prev.impl ?? prev.ozImpl)}) · ${prev.selectors.length} risky selector(s) tracked`);
    } else {
      let fired = false;
      for (const ch of changes) {
        code[ch.slot] = ch.to;
        const key = `impl:${ch.slot}:${ch.to ?? "cleared"}`;
        if (!fire(st, key)) continue;
        fired = true;
        const nc = implCode(ch.to);
        const lines: string[] = [`${ch.slot === "beacon" ? "Beacon" : ch.slot === "ozImpl" ? "Implementation (ZeppelinOS slot)" : "Implementation"} ${shortAddr(ch.from)} → ${shortAddr(ch.to)}`];
        let addedTxt = "";
        if (nc) {
          const { added, removed } = diffSelectors(prev.selectors, nc.selectors);
          addedTxt = added.length ? ` · upgrade added ${added.join(", ")}` : "";
          lines.push(added.length ? `Upgrade ADDED ${added.join(", ")}` : "No new risky selectors");
          lines.push(removed.length ? `Removed ${removed.join(", ")}` : "Removed none");
          if (nc.byteSize) lines.push(`New logic ${nc.byteSize.toLocaleString("en-US")} bytes${nc.isContract ? "" : " (NO CODE at the new implementation)"}`);
          code.selectors = nc.selectors;
        } else {
          lines.push("Selector diff unavailable: the new implementation's bytecode could not be fetched this tick");
        }
        const tx = snap.logs.admin.find((l) => l.address.toLowerCase() === w.target.toLowerCase() && (l.topics[0] === T.UPGRADED || l.topics[0] === T.BEACON_UPGRADED))?.transactionHash ?? null;
        out.alerts.push(mkAlert(ctx, w, up, "critical", `Proxy UPGRADED: ${w.label}${addedTxt}`.slice(0, 200), lines, key, { txHash: tx }));
      }
      observe(out, up, fired, fired ? "critical" : null, changes.map((c) => `${c.slot} ${shortAddr(c.from)} → ${shortAddr(c.to)}`).join(" · "));
    }
  } else {
    if (impl?.read) code.impl = impl.addr;
    if (ozImpl?.read) code.ozImpl = ozImpl.addr;
    if (beacon?.read) code.beacon = beacon.addr;
  }

  // --- Admin / owner / Safe / paused
  const ownerNow = ownerRaw !== undefined ? ownerRaw.toLowerCase() : undefined;
  if (adm) {
    let worst: Severity | null = null;
    const facts: string[] = [];
    const push = (sev: Severity, title: string, lines: string[], key: string, topic?: string) => {
      if (!fire(st, key)) return;
      const tx = topic ? (snap.logs.admin.find((l) => l.address.toLowerCase() === w.target.toLowerCase() && l.topics[0] === topic)?.transactionHash ?? null) : null;
      out.alerts.push(mkAlert(ctx, w, adm, sev, title, lines, key, { txHash: tx }));
      if (!worst || sev === "critical" || (sev === "warn" && worst === "info")) worst = sev;
    };
    if (ownerNow !== undefined && ownerNow !== prev.owner) {
      const renounced = ownerNow === ZERO || ownerNow === DEAD;
      push(renounced ? "info" : "critical", renounced ? `Ownership renounced on ${w.label}` : `Owner changed on ${w.label}: ${shortAddr(prev.owner)} → ${shortAddr(ownerNow)}`, [`owner() ${prev.owner ?? "none"} → ${ownerNow}`], `owner:${ownerNow}`, T.OWNERSHIP_TRANSFERRED);
      code.owner = ownerNow;
    }
    if (admin?.read && admin.addr !== prev.admin) {
      push("critical", `Proxy admin changed on ${w.label}: ${shortAddr(prev.admin)} → ${shortAddr(admin.addr)}`, ["EIP-1967 admin slot changed: whoever holds it can swap the logic"], `admin:${admin.addr}`, T.ADMIN_CHANGED);
      code.admin = admin.addr;
    }
    if (ozAdmin?.read && ozAdmin.addr !== prev.ozAdmin) {
      push("critical", `Proxy admin changed on ${w.label}: ${shortAddr(prev.ozAdmin)} → ${shortAddr(ozAdmin.addr)}`, ["ZeppelinOS admin slot changed: whoever holds it can swap the logic"], `ozadmin:${ozAdmin.addr}`, T.ADMIN_CHANGED);
      code.ozAdmin = ozAdmin.addr;
    }
    if (safeNow && prev.safe) {
      if (safeNow.threshold < prev.safe.threshold) push("critical", `Admin multisig threshold LOWERED on ${w.label}: ${prev.safe.threshold}-of-${prev.safe.owners.length} → ${safeNow.threshold}-of-${safeNow.owners.length}`, [`Safe ${proxy.safe}`], `safe:thr:${safeNow.threshold}:${safeNow.owners.length}`);
      else if (safeNow.threshold > prev.safe.threshold) push("info", `Admin multisig threshold raised on ${w.label}: ${prev.safe.threshold} → ${safeNow.threshold}`, [`Safe ${proxy.safe}`], `safe:thr:${safeNow.threshold}:${safeNow.owners.length}`);
      const ownersChanged = safeNow.owners.join(",") !== [...prev.safe.owners].map((o) => o.toLowerCase()).sort().join(",");
      if (ownersChanged) {
        const added = safeNow.owners.filter((o) => !prev.safe!.owners.map((x) => x.toLowerCase()).includes(o));
        const removed = prev.safe.owners.map((x) => x.toLowerCase()).filter((o) => !safeNow.owners.includes(o));
        push("warn", `Admin multisig owner set changed on ${w.label}`, [added.length ? `Added ${added.map((a) => shortAddr(a)).join(", ")}` : "", removed.length ? `Removed ${removed.map((a) => shortAddr(a)).join(", ")}` : "", `Now ${safeNow.threshold}-of-${safeNow.owners.length}`], `safe:owners:${safeNow.owners.join(",")}`);
      }
    }
    if (safeNow) code.safe = safeNow;
    if (paused !== undefined && prev.paused !== undefined && paused !== prev.paused) {
      push(paused ? "critical" : "info", paused ? `${w.label} is PAUSED: transfers/exits are frozen` : `${w.label} unpaused`, [], `paused:${paused}:${snap.block.number}`, paused ? T.PAUSED : T.UNPAUSED);
    }
    if (paused !== undefined) code.paused = paused;
    if (proxy.hasOwnerFn) facts.push(`owner ${shortAddr(code.owner)}`);
    if (admin || ozAdmin) facts.push(`proxy admin ${shortAddr(code.admin ?? code.ozAdmin)}`);
    if (code.safe) facts.push(`Safe ${code.safe.threshold}-of-${code.safe.owners.length}`);
    if (code.paused !== undefined) facts.push(code.paused ? "PAUSED" : "not paused");
    observe(out, adm, !!worst, worst, facts.join(" · "));
  } else {
    if (ownerNow !== undefined) code.owner = ownerNow;
    if (admin?.read) code.admin = admin.addr;
    if (ozAdmin?.read) code.ozAdmin = ozAdmin.addr;
    if (safeNow) code.safe = safeNow;
    if (paused !== undefined) code.paused = paused;
  }
  st.code = code;
}

/* ------------------------------------------------------------------------------------------------ */
/* $VIBES bridge lanes (peer, pause, pauser, credit budget) + adapter governance                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * State lives in `WatchState.peers` (string map):
 *   "<eid>" → peer bytes32 · "<chainId>:paused" · "<chainId>:pauser" · "<chainId>:limit" · "<chainId>:window"
 *   "gov:<chainId>:owner" · "gov:<chainId>:threshold" · "gov:<chainId>:owners"
 */
function bridgeDomain(
  ctx: EvalContext,
  w: Watch,
  st: WatchState,
  br: Extract<RuleConfig, { type: "bridge_peer_change" }> | undefined,
  adm: Extract<RuleConfig, { type: "admin_change" }> | undefined,
  out: Out,
  seed: boolean,
  hasBridgeRule: boolean,
  hasGovRule: boolean
) {
  if (!w.meta.vibes || !w.meta.bridge?.length) return;
  const wantsBridge = seed ? hasBridgeRule : !!br;
  const wantsGov = seed ? hasGovRule : !!adm;
  if (!wantsBridge && !wantsGov) return;
  const prev = st.peers;
  const next: Record<string, string> = { ...(prev ?? {}) };
  const baseline = !prev;
  let bridgeWorst: Severity | null = null;
  let govWorst: Severity | null = null;
  const bridgeFacts: string[] = [];
  const govFacts: string[] = [];
  let unavailable = 0;

  for (const lane of w.meta.bridge) {
    const snap = ctx.snap[lane.chainId];
    if (!snap) {
      unavailable++;
      continue;
    }
    const a = lane.adapter;
    const chainTag = lane.chainId === 8453 ? "Base" : "Robinhood";
    const tx = (topic: string) => snap.logs.admin.find((l) => l.address.toLowerCase() === a.toLowerCase() && l.topics[0] === topic)?.transactionHash ?? null;
    const ev = (topic?: string) => ({ chainId: lane.chainId, evidenceAddress: a, txHash: topic ? tx(topic) : null });

    if (wantsBridge) {
      const peer = val<string>(snap, a, "peers", [lane.eid]);
      const paused = val<boolean>(snap, a, "paused");
      const pauser = val<string>(snap, a, "pauser");
      const rl = val<readonly [bigint, bigint, bigint, bigint]>(snap, a, "rateLimits", [lane.eid]);
      const cb = val<readonly [bigint, bigint]>(snap, a, "creditBudget", [lane.eid]);
      if (peer === undefined && paused === undefined && rl === undefined) unavailable++;
      const set = (k: string, v: string | undefined) => {
        if (v !== undefined) next[k] = v;
      };
      if (!baseline && br) {
        const expected = pad32(lane.expectedPeer);
        if (peer !== undefined && peer.toLowerCase() !== expected) {
          const key = `peer:${lane.chainId}:${lane.eid}:${peer.toLowerCase()}`;
          if (fire(st, key)) {
            bridgeWorst = "critical";
            const peerAddr = /^0x0{24}/i.test(peer) ? `0x${peer.slice(26)}` : peer;
            out.alerts.push(mkAlert(ctx, w, br, "critical", `OFT peer for EID ${lane.eid} changed on the ${chainTag} adapter: ${shortAddr(lane.expectedPeer)} → ${shortAddr(peerAddr)}`, [
              "Locked VIBES are at risk: the adapter now trusts a different remote contract",
              `Adapter ${a}`,
            ], key, ev(T.PEER_SET)));
          }
        }
        if (paused !== undefined && prev?.[`${lane.chainId}:paused`] !== undefined && String(paused) !== prev[`${lane.chainId}:paused`]) {
          const key = `bpaused:${lane.chainId}:${paused}:${snap.block.number}`;
          if (fire(st, key)) {
            const sev: Severity = paused ? "critical" : "info";
            bridgeWorst = bridgeWorst === "critical" ? "critical" : sev;
            out.alerts.push(mkAlert(ctx, w, br, sev, paused ? `$VIBES bridge PAUSED on the ${chainTag} adapter` : `RESOLVED: $VIBES bridge unpaused on the ${chainTag} adapter`, [
              paused ? "Pause blocks both sends and deliveries; paused deliveries stay retriable after unpause (only the owner Safe can unpause)" : "",
            ], key, ev(paused ? T.PAUSED : T.UNPAUSED)));
          }
        }
        if (pauser !== undefined && prev?.[`${lane.chainId}:pauser`] && pauser.toLowerCase() !== prev[`${lane.chainId}:pauser`]) {
          const key = `pauser:${lane.chainId}:${pauser.toLowerCase()}`;
          if (fire(st, key)) {
            bridgeWorst = "critical";
            out.alerts.push(mkAlert(ctx, w, br, "critical", `$VIBES bridge pauser changed on the ${chainTag} adapter: ${shortAddr(prev[`${lane.chainId}:pauser`])} → ${shortAddr(pauser)}`, [], key, ev()));
          }
        }
        if (rl && prev?.[`${lane.chainId}:limit`] !== undefined && (rl[2].toString() !== prev[`${lane.chainId}:limit`] || rl[3].toString() !== prev[`${lane.chainId}:window`])) {
          const key = `limit:${lane.chainId}:${rl[2]}:${rl[3]}`;
          if (fire(st, key)) {
            bridgeWorst = "critical";
            out.alerts.push(mkAlert(ctx, w, br, "critical", `$VIBES bridge credit budget changed (${BRIDGE_LANE_NAME[lane.chainId]})`, [
              `${fmtUnits(prev[`${lane.chainId}:limit`], 18, 0)} VIBES per ${prev[`${lane.chainId}:window`]} s → ${fmtUnits(rl[2], 18, 0)} VIBES per ${rl[3]} s (${BRIDGE_LANE_ENFORCER[lane.chainId]})`,
              "The budget caps how much VIBES a lane can credit per window (and the damage from a forged message)",
            ], key, ev()));
          }
        }
      }
      if (rl && cb && rl[2] > 0n) {
        const headBps = Number((cb[1] * 10_000n) / rl[2]);
        const fk = `${br?.id ?? "r_bridge_peer_change"}:headroom:${lane.chainId}`;
        bridgeFacts.push(`${chainTag} lane headroom ${fmtUnits(cb[1], 18, 0)} / ${fmtUnits(rl[2], 18, 0)} (${pctStr(headBps)})`);
        if (!baseline && br) {
          if (headBps < CREDIT_HEADROOM_WARN_BPS && !st.firing[fk]) {
            st.firing[fk] = true;
            const key = `headroom:${lane.chainId}:${snap.block.number}`;
            if (fire(st, key)) {
              bridgeWorst = bridgeWorst ?? "warn";
              const refillSec = rl[2] > 0n ? Number(((rl[2] - cb[1]) * rl[3]) / rl[2]) : 0;
              out.alerts.push(mkAlert(ctx, w, br, "warn", `$VIBES bridge credit headroom low: ${pctStr(headBps)} left (${BRIDGE_LANE_NAME[lane.chainId]})`, [
                `In flight ${fmtUnits(cb[0], 18, 0)} · can credit ${fmtUnits(cb[1], 18, 0)} of ${fmtUnits(rl[2], 18, 0)} VIBES per ${rl[3]} s (${BRIDGE_LANE_ENFORCER[lane.chainId]})`,
                `Transfers above the headroom revert RateLimitExceeded at the destination and wait (full refill in ~${fmtDuration(refillSec)})`,
              ], key, ev()));
            }
          } else if (headBps > CREDIT_HEADROOM_REARM_BPS) st.firing[fk] = false;
        }
      }
      set(String(lane.eid), peer?.toLowerCase());
      set(`${lane.chainId}:paused`, paused === undefined ? undefined : String(paused));
      set(`${lane.chainId}:pauser`, pauser?.toLowerCase());
      set(`${lane.chainId}:limit`, rl?.[2].toString());
      set(`${lane.chainId}:window`, rl?.[3].toString());
      if (peer !== undefined) bridgeFacts.push(`${chainTag} peer ${peer.toLowerCase() === pad32(lane.expectedPeer) ? "OK" : "CHANGED"}`);
      if (paused) bridgeFacts.push(`${chainTag} PAUSED`);
    }

    if (wantsGov) {
      // Skip what codeDomain already covers for the target itself.
      const selfAdapter = lane.adapter.toLowerCase() === w.target.toLowerCase() && lane.chainId === w.chainId && !!w.meta.proxy?.hasOwnerFn;
      const selfSafe = lane.chainId === w.chainId && !!w.meta.proxy?.safe && w.meta.proxy.safe.toLowerCase() === VIBES_ADMIN_SAFE.toLowerCase();
      const owner = selfAdapter ? undefined : val<string>(snap, a, "owner")?.toLowerCase();
      const thr = selfSafe ? undefined : val<bigint>(snap, VIBES_ADMIN_SAFE, "getThreshold");
      const owners = selfSafe ? undefined : val<readonly string[]>(snap, VIBES_ADMIN_SAFE, "getOwners")?.map((o) => o.toLowerCase()).sort().join(",");
      const kO = `gov:${lane.chainId}:owner`;
      const kT = `gov:${lane.chainId}:threshold`;
      const kS = `gov:${lane.chainId}:owners`;
      if (!baseline && adm) {
        if (owner !== undefined && prev?.[kO] && owner !== prev[kO]) {
          const key = `gov:owner:${lane.chainId}:${owner}`;
          if (fire(st, key)) {
            govWorst = "critical";
            out.alerts.push(mkAlert(ctx, w, adm, "critical", `$VIBES ${chainTag} bridge adapter owner changed: ${shortAddr(prev[kO])} → ${shortAddr(owner)}`, ["The owner controls peers, credit budgets, DVN config and unpause"], key, ev(T.OWNERSHIP_TRANSFERRED)));
          }
        }
        if (thr !== undefined && prev?.[kT] && Number(thr) < Number(prev[kT])) {
          const key = `gov:thr:${lane.chainId}:${thr}`;
          if (fire(st, key)) {
            govWorst = "critical";
            const n = (owners ?? prev[kS] ?? "").split(",").filter(Boolean).length;
            out.alerts.push(mkAlert(ctx, w, adm, "critical", `Admin multisig threshold LOWERED on the $VIBES bridge owner ${shortAddr(VIBES_ADMIN_SAFE)} (${chainTag}): ${prev[kT]}-of-${n} → ${thr}-of-${n}`, [], key, { chainId: lane.chainId, evidenceAddress: VIBES_ADMIN_SAFE }));
          }
        }
        if (owners !== undefined && prev?.[kS] && owners !== prev[kS]) {
          const key = `gov:owners:${lane.chainId}:${owners}`;
          if (fire(st, key)) {
            govWorst = govWorst ?? "warn";
            out.alerts.push(mkAlert(ctx, w, adm, "warn", `$VIBES bridge owner Safe ${shortAddr(VIBES_ADMIN_SAFE)} changed its signer set (${chainTag})`, [`Now ${owners.split(",").length} owners`], key, { chainId: lane.chainId, evidenceAddress: VIBES_ADMIN_SAFE }));
          }
        }
      }
      if (owner !== undefined) next[kO] = owner;
      if (thr !== undefined) next[kT] = thr.toString();
      if (owners !== undefined) next[kS] = owners;
      if (thr !== undefined) govFacts.push(`${chainTag} owner Safe ${thr}-of-${(owners ?? "").split(",").filter(Boolean).length}`);
    }
  }
  st.peers = next;
  if (br) observe(out, br, !!bridgeWorst, bridgeWorst, baseline ? "baseline recorded" : bridgeFacts.join(" · ") || (unavailable ? "bridge reads unavailable this tick" : "no lane data"));
  if (adm && !w.meta.proxy) observe(out, adm, !!govWorst, govWorst, baseline ? "baseline recorded" : govFacts.join(" · ") || "governance reads unavailable this tick");
  else if (adm && govWorst) {
    const o = out.obs.find((x) => x.ruleId === adm.id);
    if (o) {
      o.fired = true;
      o.severity = govWorst === "critical" || o.severity === null ? govWorst : o.severity;
      o.observed = `${o.observed} · ${govFacts.join(" · ")}`;
    }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Supply + whale transfers                                                                          */
/* ------------------------------------------------------------------------------------------------ */

function supplyDomain(ctx: EvalContext, w: Watch, st: WatchState, snap: ChainSnapshot, r: Extract<RuleConfig, { type: "supply_change" }> | undefined, out: Out, active: boolean) {
  const tok = w.meta.token;
  if (!tok || !active) return;
  const supply = val<bigint>(snap, tok.address, "totalSupply");
  if (supply === undefined) {
    if (r) observe(out, r, false, null, "totalSupply read unavailable this tick");
    return;
  }
  if (!st.supply) {
    st.supply = { armed: supply.toString(), last: supply.toString() };
    if (r) observe(out, r, false, null, "baseline recorded");
    return;
  }
  const armed = BigInt(st.supply.armed);
  const last = BigInt(st.supply.last);
  const d = armed > 0n ? Number(((supply - armed) * 10_000n) / armed) : 0;
  const observed = `${fmtUnits(supply, tok.decimals, 2)} ${tok.symbol} (${fmtBps(d)} vs armed)`;
  if (r) {
    if (supply !== last && Math.abs(d) >= r.minBps && !cooling(st, r, ctx.now)) {
      const key = `supply:${supply}`;
      if (fire(st, key)) {
        startCooldown(st, r, ctx.now);
        const up = supply > armed;
        const delta = up ? supply - armed : armed - supply;
        out.alerts.push(mkAlert(ctx, w, r, up ? "critical" : "warn", `${tok.symbol} (${chainName(w.chainId)}) totalSupply ${up ? "+" : "−"}${fmtUnits(delta, tok.decimals, 2)} (${fmtBps(d)}) vs armed${up ? ": unexpected mint" : ""}`, [
          `${fmtUnits(armed, tok.decimals, 2)} → ${fmtUnits(supply, tok.decimals, 2)} ${tok.symbol}`,
          `Block #${snap.block.number}`,
        ], key, { evidenceAddress: tok.address }));
        observe(out, r, true, up ? "critical" : "warn", observed);
      } else observe(out, r, false, null, observed);
    } else observe(out, r, false, null, observed);
  }
  st.supply = { armed: st.supply.armed, last: supply.toString() };
}

function whaleTransfer(ctx: EvalContext, w: Watch, st: WatchState, r: Extract<RuleConfig, { type: "whale_transfer" }>, snap: ChainSnapshot, out: Out) {
  const tok = w.meta.token;
  if (!tok) return observe(out, r, false, null, "no token metadata");
  if (!snap.logsOk) return observe(out, r, false, null, "transfer logs unavailable this tick");
  const supply = val<bigint>(snap, tok.address, "totalSupply") ?? (st.supply ? BigInt(st.supply.last) : 0n);
  if (supply === 0n) return observe(out, r, false, null, "totalSupply unavailable");
  const threshold = (supply * BigInt(r.minBpsOfSupply)) / 10_000n;
  const pool = w.meta.pool?.address.toLowerCase();
  const adapters = new Set((w.meta.bridge ?? []).map((b) => b.adapter.toLowerCase()));
  const logs = snap.logs.transfers.filter((l) => l.address.toLowerCase() === tok.address.toLowerCase() && l.topics[0] === T.TRANSFER && l.topics.length === 3);
  let count = 0;
  let worst: Severity | null = null;
  for (const l of logs) {
    let value: bigint;
    try {
      [value] = decodeAbiParameters([{ type: "uint256" }], l.data);
    } catch {
      continue;
    }
    if (value < threshold) continue;
    const from = topicAddr(l.topics[1] ?? undefined) ?? ZERO;
    const to = topicAddr(l.topics[2] ?? undefined) ?? ZERO;
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (count >= 5 || !fire(st, key)) continue;
    count++;
    const bps = Number((value * 10_000n) / supply);
    const kind = from === ZERO ? "MINT" : to === ZERO || to === DEAD ? "BURN" : pool && to === pool ? "SELL" : pool && from === pool ? "BUY" : adapters.has(to) || adapters.has(from) ? "BRIDGE" : "TRANSFER";
    const sev: Severity = kind === "MINT" || bps >= 500 ? "critical" : "warn";
    if (sev === "critical" || !worst) worst = sev;
    const verb = kind === "SELL" ? `sent into ${label(to)}` : kind === "BUY" ? `bought from ${label(from)}` : kind === "MINT" ? `minted to ${label(to)}` : kind === "BURN" ? "burned" : `sent to ${label(to)}`;
    out.alerts.push(mkAlert(ctx, w, r, sev, `Whale ${kind}: ${kind === "MINT" ? "" : `${label(from)} `}${verb} ${fmtCompact18(value, tok.decimals)} ${tok.symbol} (${pctStr(bps)} of supply)`.replace(/\s+/g, " "), [
      `${fmtUnits(value, tok.decimals, 2)} ${tok.symbol} · from ${from} → ${to}`,
      `Block #${l.blockNumber?.toString() ?? snap.block.number.toString()}`,
    ], key, { txHash: l.transactionHash, block: l.blockNumber?.toString() }));
  }
  observe(out, r, count > 0, worst, `${logs.length} transfer(s) in blocks #${snap.range.from}–#${snap.range.to} · threshold ${fmtUnits(threshold, tok.decimals, 0)} ${tok.symbol}`);
}

function fmtCompact18(v: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  if (whole >= 1_000_000n) return `${fmtUnits((v * 10n) / 1_000_000n, decimals + 1, 2)}M`;
  if (whole >= 1_000n) return `${fmtUnits((v * 10n) / 1_000n, decimals + 1, 2)}K`;
  return fmtUnits(v, decimals, 2);
}

/* ------------------------------------------------------------------------------------------------ */
/* band_change (fed by the tick's periodic scan pass)                                                */
/* ------------------------------------------------------------------------------------------------ */

const BAND_RANK = { NOMINAL: 0, ELEVATED: 1, CRITICAL: 2 } as const;

/** True when this watch's band_change rule wants a fresh scan now. */
export function scanDue(w: Watch, st: WatchState | undefined, now: number): boolean {
  const r = w.rules.find((x) => x.type === "band_change" && x.enabled) as Extract<RuleConfig, { type: "band_change" }> | undefined;
  if (!r || !w.enabled) return false;
  return !st?.scan || now - st.scan.at >= r.everyMin * 60_000;
}

/**
 * Apply a scan result (from scanTarget(…, { useLlm: false })) to the state. Pages when the band
 * WORSENS on two consecutive scans (pendingBand). Mutates and returns `st` (pass a clone).
 */
export function applyScan(
  ctx: Pick<EvalContext, "now" | "links" | "snap">,
  w: Watch,
  st: WatchState,
  scan: { score: number; band: keyof typeof BAND_RANK; block: { number: string }; findings: { title: string; severity: string }[] }
): PagerAlert[] {
  const r = w.rules.find((x) => x.type === "band_change" && x.enabled);
  const prev = st.scan;
  const out: PagerAlert[] = [];
  let pendingBand: keyof typeof BAND_RANK | undefined;
  if (r && prev && BAND_RANK[scan.band] > BAND_RANK[prev.band]) {
    if (prev.pendingBand === scan.band) {
      const key = `band:${scan.band}:${Math.floor(ctx.now / 86_400_000)}`;
      if (fire(st, key)) {
        const top = scan.findings.filter((f) => f.severity !== "info").slice(0, 3).map((f) => f.title);
        out.push(mkAlert({ ...ctx, globals: EMPTY_GLOBALS } as EvalContext, w, r, scan.band === "CRITICAL" ? "critical" : "warn", `Threat band ${prev.band} → ${scan.band} (${scan.score}/100)${top.length ? `: ${top.join("; ")}` : ""}`.slice(0, 200), [
          `Confirmed on two consecutive scans · block #${scan.block.number}`,
        ], key, { block: scan.block.number }));
      }
    } else {
      pendingBand = scan.band;
      st.scan = { ...prev, pendingBand };
      return out;
    }
  }
  st.scan = { score: scan.score, band: scan.band, at: ctx.now, block: scan.block.number, ...(pendingBand ? { pendingBand } : {}) };
  for (const a of out) {
    st.alertCount = (st.alertCount ?? 0) + 1;
    st.lastAlert = { ruleType: a.ruleType, title: a.title, severity: a.severity, at: a.at };
  }
  return out;
}
