import { type Address, getAddress, type Log, parseEventLogs } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { AERODROME_FACTORY_ABI, AERODROME_POOL_ABI, ERC20_ABI, UNISWAP_V3_POOL_ABI } from "@/lib/abis";
import {
  AERODROME_POOL_EVENTS_ABI,
  BASE_POOL_VENUES,
  CL_POOL_ABI,
  isSlipstreamFactory,
  SLIPSTREAM_FACTORY_ABI,
  UNISWAP_V3_FACTORY_FEE_ABI,
  UNISWAP_V3_FEE_TIERS,
} from "@/lib/abis/pools-extra";
import { v2PricesScaled18, v3PricesScaled18, v3VirtualReserves } from "@/lib/amm-math";
import { cached } from "@/lib/cache";
import { getPublicClientForChain } from "@/lib/rpc";
import { isRpcFailure } from "./call-errors";
import { blockHoursAgo, readTokenMeta } from "./chain-utils";
import { getLogsChunked } from "./logs";
import { QUOTE_ASSETS, quoteSideOf, venueLabel, wethAddress, wethSideOf } from "./sides";
import type { ChainId, OvernightPoolDelta, PoolSnapshot, TokenMeta } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
const Q96 = 1n << 96n;
export const OVERNIGHT_HOURS = 8;

function bpsChange(before: bigint, after: bigint): number | null {
  if (before === 0n) return null;
  return Number(((after - before) * 10_000n) / before);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n < 0n ? 0n : n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

type Settled<T> = { ok: true; value: T } | { ok: false };
async function settled<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch {
    return { ok: false };
  }
}

/**
 * Address-filtered eth_getLogs over the overnight window via the shared provider-aware chunker
 * (publicnode caps Base at 50k blocks/query; Base runs 200 ms blocks, so 8h ≈ 144k blocks).
 * Only a COMPLETE, untruncated read counts — a partial window would undercount swaps/LP flows,
 * so it is reported as unavailable instead.
 */
async function poolLogs(chainId: ChainId, address: Address, fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
  const res = await getLogsChunked(chainId, { address, fromBlock, toBlock }, { maxLogs: 20_000, timeBudgetMs: 15_000 });
  if (!res.complete || res.truncated) throw new Error(res.note || "incomplete log window");
  return res.logs;
}

/** Price of the risky token in the quote token (scaled 1e18); risky = token0 when no quote side is known. */
function riskyPrice(p: { token1PerToken0: bigint; token0PerToken1: bigint }, quoteSide: 0 | 1 | null): bigint {
  return quoteSide === 0 ? p.token0PerToken1 : p.token1PerToken0;
}

function orientation(t0: TokenMeta, t1: TokenMeta, quoteSide: 0 | 1 | null): string {
  return quoteSide === 0 ? `${t1.symbol} priced in ${t0.symbol}` : `${t0.symbol} priced in ${t1.symbol}`;
}

interface PoolCtx {
  chainId: ChainId;
  address: Address;
  token0: TokenMeta;
  token1: TokenMeta;
  quoteSide: 0 | 1 | null;
  latest: bigint;
  latestTs: bigint;
}

/**
 * Block at (latest timestamp − 8h). Starts from the live average block time and then corrects against real
 * block timestamps (secant steps on the measured local rate), so it stays right across Base's 2 s → 200 ms
 * block-time switch. Never returns a block outside (0, latest].
 */
async function overnightFromBlock(ctx: PoolCtx): Promise<bigint> {
  const client = getPublicClientForChain(ctx.chainId);
  const target = ctx.latestTs - BigInt(OVERNIGHT_HOURS * 3600);
  let est = await blockHoursAgo(ctx.chainId, client, ctx.latest, OVERNIGHT_HOURS);
  for (let i = 0; i < 3 && est > 0n; i++) {
    const b = await client.getBlock({ blockNumber: est });
    const err = b.timestamp - target; // seconds; >0 → est is too recent
    if (err >= -120n && err <= 120n) break;
    const dn = ctx.latest - b.number;
    const dt = ctx.latestTs - b.timestamp;
    if (dn <= 0n || dt <= 0n) break;
    const step = (err * dn) / dt; // blocks to move back (err>0) or forward (err<0)
    let next = est - step;
    if (next < 1n) next = 1n;
    if (next > ctx.latest) next = ctx.latest;
    if (next === est) break;
    est = next;
  }
  if (est <= 0n) throw new Error("could not resolve the overnight block");
  return est;
}


/**
 * Reads any Aerodrome v2 (volatile/stable) / Uniswap-v2-style pool, or any concentrated-liquidity pool
 * (Uniswap v3 and Aerodrome Slipstream — slot0 decoded to its first two words, which both share) live,
 * and computes an overnight (8h) delta. Returns null if the address is not a recognizable pool.
 */
export async function readPool(chainId: ChainId, address: Address, opts: { overnight?: boolean } = {}): Promise<PoolSnapshot | null> {
  const client = getPublicClientForChain(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const blockNumber = latest.number;

  const [t0, t1, reserves, slot0, liq, fee, stable, factory, tickSpacing, lpSupply] = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: [
      { address, abi: AERODROME_POOL_ABI, functionName: "token0" },
      { address, abi: AERODROME_POOL_ABI, functionName: "token1" },
      { address, abi: AERODROME_POOL_ABI, functionName: "getReserves" },
      { address, abi: CL_POOL_ABI, functionName: "slot0" },
      { address, abi: CL_POOL_ABI, functionName: "liquidity" },
      { address, abi: CL_POOL_ABI, functionName: "fee" },
      { address, abi: AERODROME_POOL_ABI, functionName: "stable" },
      { address, abi: AERODROME_POOL_ABI, functionName: "factory" },
      { address, abi: CL_POOL_ABI, functionName: "tickSpacing" },
      { address, abi: AERODROME_POOL_ABI, functionName: "totalSupply" },
    ],
  });
  // An RPC failure is not "not a pool": throw so callers report UNKNOWN instead of a clean non-pool verdict.
  if ([t0, t1, reserves, slot0, liq].some((r) => isRpcFailure(r))) throw new Error(`RPC error while reading pool ${address} — retry`);
  if (t0.status !== "success" || t1.status !== "success") return null;
  const isCL = slot0.status === "success" && liq.status === "success";
  const isV2 = !isCL && reserves.status === "success";
  if (!isV2 && !isCL) return null;

  const [token0, token1] = await Promise.all([
    readTokenMeta(chainId, getAddress(t0.result)),
    readTokenMeta(chainId, getAddress(t1.result)),
  ]);
  if (!token0 || !token1) return null;

  const factoryAddr = factory.status === "success" ? getAddress(factory.result) : null;
  const block = { chainId, number: blockNumber.toString(), timestamp: Number(latest.timestamp) };
  const wethSide = wethSideOf(chainId, token0.address, token1.address);
  const quoteSide = quoteSideOf(chainId, token0.address, token1.address);
  const ctx: PoolCtx = { chainId, address, token0, token1, quoteSide, latest: blockNumber, latestTs: latest.timestamp };

  if (isCL) {
    const sqrtP = slot0.result[0];
    const tick = Number(slot0.result[1]);
    const L = liq.result;
    const kind: PoolSnapshot["kind"] = isSlipstreamFactory(chainId, factoryAddr) ? "aerodrome-cl" : "uniswap-v3";
    const ts = tickSpacing.status === "success" ? Number(tickSpacing.result) : null;
    const { reserve0, reserve1 } = v3VirtualReserves(sqrtP, L);
    const prices = v3PricesScaled18(sqrtP, token0.decimals, token1.decimals);
    // fee() is in pips (1e-6): Uniswap 500 = 5 bps, Slipstream 150 = 1.5 bps. Unreadable → conservative 1%.
    const feePips = fee.status === "success" ? Number(fee.result) : 10_000;
    const overnight = opts.overnight === false ? skipped() : await clOvernight(ctx, sqrtP, L, tick);
    return {
      chainId, address, kind, venue: venueLabel({ kind, stable: false, tickSpacing: ts }), token0, token1,
      feeBps: Math.ceil(feePips / 100), feePips, tickSpacing: ts, wethSide, quoteSide, stable: false, factory: factoryAddr,
      reserve0: reserve0.toString(), reserve1: reserve1.toString(), reservesAreVirtual: true,
      sqrtPriceX96: sqrtP.toString(), liquidity: L.toString(), tick,
      token1PerToken0: prices.token1PerToken0.toString(), token0PerToken1: prices.token0PerToken1.toString(),
      block, overnight,
    };
  }

  const r = reserves.result as readonly [bigint, bigint, bigint];
  const isStable = stable.status === "success" ? Boolean(stable.result) : false;
  let feeBps = 30;
  if (factoryAddr) {
    try {
      // Aerodrome PoolFactory.getFee is in bps (denominator 10,000)
      const f = Number(await client.readContract({ address: factoryAddr, abi: AERODROME_FACTORY_ABI, functionName: "getFee", args: [address, isStable] }));
      if (Number.isFinite(f) && f >= 0 && f <= 10_000) feeBps = Math.ceil(f);
    } catch {
      /* non-Aerodrome v2 fork: keep 30 bps */
    }
  }
  const prices = v2PricesScaled18(r[0], r[1], token0.decimals, token1.decimals);
  const supplyNow = lpSupply.status === "success" ? lpSupply.result : null;
  const overnight = opts.overnight === false ? skipped() : await v2Overnight(ctx, r[0], r[1], supplyNow, isStable);
  return {
    chainId, address, kind: "aerodrome-v2", venue: venueLabel({ kind: "aerodrome-v2", stable: isStable }), token0, token1,
    feeBps, feePips: feeBps * 100, tickSpacing: null, wethSide, quoteSide, stable: isStable, factory: factoryAddr,
    reserve0: r[0].toString(), reserve1: r[1].toString(), reservesAreVirtual: false,
    sqrtPriceX96: null, liquidity: null, tick: null,
    token1PerToken0: prices.token1PerToken0.toString(), token0PerToken1: prices.token0PerToken1.toString(),
    block, overnight,
  };
}

function skipped(): OvernightPoolDelta {
  return {
    method: "unavailable", hours: OVERNIGHT_HOURS, fromBlock: null,
    reserve0ChangeBps: null, lpChangeBps: null, lpMethod: null, quoteReserveChangeBps: null,
    priceChangeBps: null, priceOrientation: null, swapCount: null, token0Volume: null, quoteVolume: null,
    note: "Overnight delta not requested.",
  };
}

/**
 * v2 overnight: archive getReserves()/totalSupply() at the block ~8h ago (Base serves it), plus Swap/Mint/Burn
 * logs. LP liquidity = LP-token totalSupply change (swaps never move it); without archive state the past
 * reserves are rebuilt from the logs and LP is measured by √k (volatile pools; Aerodrome sends fees out of
 * the pool, so swaps leave k unchanged).
 */
async function v2Overnight(ctx: PoolCtx, r0: bigint, r1: bigint, supplyNow: bigint | null, stable: boolean): Promise<OvernightPoolDelta> {
  const { chainId, address: pool, latest, token0, token1, quoteSide } = ctx;
  const client = getPublicClientForChain(chainId);
  let fromBlock: bigint;
  try {
    fromBlock = await overnightFromBlock(ctx);
  } catch {
    return { ...skipped(), note: "Could not resolve historical block height." };
  }
  const [hist, rawLogs] = await Promise.all([
    settled(
      Promise.all([
        client.readContract({ address: pool, abi: AERODROME_POOL_ABI, functionName: "getReserves", blockNumber: fromBlock }),
        client.readContract({ address: pool, abi: AERODROME_POOL_ABI, functionName: "totalSupply", blockNumber: fromBlock }).catch(() => null),
      ])
    ),
    settled(poolLogs(chainId, pool, fromBlock + 1n, latest)),
  ]);

  // Flow from logs (also used to rebuild past reserves when archive state is missing)
  let swapCount: number | null = null;
  let token0Volume: string | null = null;
  let quoteVolume: string | null = null;
  let net0 = 0n;
  let net1 = 0n;
  let mints = 0;
  let burns = 0;
  if (rawLogs.ok) {
    const logs = parseEventLogs({ abi: AERODROME_POOL_EVENTS_ABI, logs: rawLogs.value, strict: false });
    let swaps = 0;
    let vol0 = 0n;
    let vol1 = 0n;
    for (const l of logs) {
      if (l.eventName === "Swap") {
        swaps++;
        const a0i = l.args.amount0In ?? 0n, a0o = l.args.amount0Out ?? 0n, a1i = l.args.amount1In ?? 0n, a1o = l.args.amount1Out ?? 0n;
        vol0 += a0i + a0o;
        vol1 += a1i + a1o;
        net0 += a0i - a0o;
        net1 += a1i - a1o;
      } else if (l.eventName === "Mint") {
        mints++;
        net0 += l.args.amount0 ?? 0n;
        net1 += l.args.amount1 ?? 0n;
      } else if (l.eventName === "Burn") {
        burns++;
        net0 -= l.args.amount0 ?? 0n;
        net1 -= l.args.amount1 ?? 0n;
      }
    }
    swapCount = swaps;
    token0Volume = vol0.toString();
    quoteVolume = quoteSide === null ? null : (quoteSide === 0 ? vol0 : vol1).toString();
  }

  let past0: bigint | null = null;
  let past1: bigint | null = null;
  let lpChangeBps: number | null = null;
  let lpMethod: string | null = null;
  let method: OvernightPoolDelta["method"] = "unavailable";
  let note: string;
  if (hist.ok) {
    [past0, past1] = [hist.value[0][0], hist.value[0][1]];
    const pastSupply = hist.value[1];
    method = "historical-state";
    if (pastSupply !== null && supplyNow !== null) {
      lpChangeBps = bpsChange(pastSupply, supplyNow);
      lpMethod = "pool LP-token totalSupply() (moves only on LP mint/burn)";
    } else if (!stable) {
      lpChangeBps = bpsChange(isqrt(past0 * past1), isqrt(r0 * r1));
      lpMethod = "√(reserve0·reserve1)";
    }
    note = `getReserves()/totalSupply() at block #${fromBlock} vs latest${swapCount !== null ? `; ${swapCount} swaps, ${mints} LP adds, ${burns} LP removals` : ""}.`;
  } else if (rawLogs.ok) {
    past0 = r0 - net0;
    past1 = r1 - net1;
    method = "event-logs";
    if (past0 <= 0n || past1 <= 0n) {
      past0 = past1 = null;
    } else if (!stable) {
      lpChangeBps = mints === 0 && burns === 0 ? 0 : bpsChange(isqrt(past0 * past1), isqrt(r0 * r1));
      lpMethod = "√k from reserves rebuilt out of Swap/Mint/Burn logs";
    }
    note = `Archive state unavailable; reserves at block #${fromBlock} rebuilt from ${swapCount} swaps, ${mints} LP adds, ${burns} LP removals.`;
  } else {
    note = "RPC served neither historical state nor event logs for this window.";
  }

  let priceChangeBps: number | null = null;
  let quoteReserveChangeBps: number | null = null;
  if (past0 !== null && past1 !== null) {
    const pastP = riskyPrice(v2PricesScaled18(past0, past1, token0.decimals, token1.decimals), quoteSide);
    const nowP = riskyPrice(v2PricesScaled18(r0, r1, token0.decimals, token1.decimals), quoteSide);
    priceChangeBps = bpsChange(pastP, nowP);
    if (quoteSide !== null) quoteReserveChangeBps = bpsChange(quoteSide === 0 ? past0 : past1, quoteSide === 0 ? r0 : r1);
  }
  return {
    method, hours: OVERNIGHT_HOURS, fromBlock: fromBlock.toString(),
    reserve0ChangeBps: lpChangeBps, lpChangeBps, lpMethod, quoteReserveChangeBps,
    priceChangeBps, priceOrientation: orientation(token0, token1, quoteSide),
    swapCount, token0Volume, quoteVolume, note,
  };
}

/**
 * Price just BEFORE a v3/CL swap, from its Swap event (post-swap sqrtPriceX96 and liquidity L).
 * Uses the OUTPUT leg, which carries no fee: Δ√P = Δy/L for token1, Δ(1/√P) = Δx/L for token0.
 * Exact while the swap stays inside one initialized tick range.
 */
export function preSwapSqrtPriceX96(amount0: bigint, amount1: bigint, sqrtPost: bigint, L: bigint): bigint | null {
  if (L <= 0n || sqrtPost <= 0n) return null;
  if (amount1 < 0n) return sqrtPost - (amount1 * Q96) / L;
  if (amount0 < 0n) {
    const xPre = (L * Q96) / sqrtPost - amount0;
    return xPre > 0n ? (L * Q96) / xPre : null;
  }
  return null;
}

/**
 * Concentrated liquidity (Uniswap v3 / Slipstream): archive slot0 + liquidity at the block ~8h ago when
 * served (Base), and Swap/Mint/Burn logs over the window (Robinhood prunes state after ~10k blocks but
 * retains logs). LP liquidity is measured from Mint/Burn amounts in ranges covering the current tick.
 */
async function clOvernight(ctx: PoolCtx, sqrtNow: bigint, Lnow: bigint, tickNow: number): Promise<OvernightPoolDelta> {
  const { chainId, address: pool, latest, token0, token1, quoteSide } = ctx;
  const client = getPublicClientForChain(chainId);
  let fromBlock: bigint;
  try {
    fromBlock = await overnightFromBlock(ctx);
  } catch {
    return { ...skipped(), note: "Could not resolve historical block height." };
  }
  const [hist, rawLogs] = await Promise.all([
    settled(
      Promise.all([
        client.readContract({ address: pool, abi: CL_POOL_ABI, functionName: "slot0", blockNumber: fromBlock }),
        client.readContract({ address: pool, abi: CL_POOL_ABI, functionName: "liquidity", blockNumber: fromBlock }),
      ])
    ),
    // Address-only query, decoded locally: Robinhood caps OR'd topic filters but serves address queries.
    settled(poolLogs(chainId, pool, fromBlock + 1n, latest)),
  ]);

  let swapCount: number | null = null;
  let token0Volume: string | null = null;
  let quoteVolume: string | null = null;
  let firstSwapPre: bigint | null = null;
  let dLInRange = 0n;
  let lpEvents = 0;
  if (rawLogs.ok) {
    const logs = parseEventLogs({ abi: CL_POOL_ABI, logs: rawLogs.value, strict: false });
    let swaps = 0;
    let vol0 = 0n;
    let vol1 = 0n;
    for (const l of logs) {
      if (l.eventName === "Swap") {
        swaps++;
        const a0 = l.args.amount0 ?? 0n;
        const a1 = l.args.amount1 ?? 0n;
        vol0 += a0 < 0n ? -a0 : a0;
        vol1 += a1 < 0n ? -a1 : a1;
        if (swaps === 1 && l.args.sqrtPriceX96 !== undefined && l.args.liquidity !== undefined) {
          firstSwapPre = preSwapSqrtPriceX96(a0, a1, l.args.sqrtPriceX96, l.args.liquidity);
        }
      } else if (l.eventName === "Mint" || l.eventName === "Burn") {
        const lo = l.args.tickLower, hi = l.args.tickUpper, amt = l.args.amount;
        if (lo === undefined || hi === undefined || amt === undefined) continue;
        lpEvents++;
        if (lo <= tickNow && tickNow < hi) dLInRange += l.eventName === "Mint" ? amt : -amt;
      }
    }
    swapCount = swaps;
    token0Volume = vol0.toString();
    quoteVolume = quoteSide === null ? null : (quoteSide === 0 ? vol0 : vol1).toString();
  }

  // Price baseline: archive slot0 at fromBlock (exact) → else the PRE-swap price of the first overnight
  // swap (never its post-swap price, which would hide a single overnight dump) → else unchanged if no swaps.
  const baseline = hist.ok ? hist.value[0][0] : firstSwapPre ?? (rawLogs.ok && swapCount === 0 ? sqrtNow : null);
  const priceOf = (s: bigint) => riskyPrice(v3PricesScaled18(s, token0.decimals, token1.decimals), quoteSide);
  const priceChangeBps = baseline !== null && baseline > 0n ? bpsChange(priceOf(baseline), priceOf(sqrtNow)) : null;

  let lpChangeBps: number | null = null;
  let lpMethod: string | null = null;
  if (rawLogs.ok) {
    const before = Lnow - dLInRange;
    lpChangeBps = dLInRange === 0n ? 0 : before > 0n ? Number((dLInRange * 10_000n) / before) : null;
    lpMethod = "liquidity added/removed by Mint/Burn in ranges covering the current tick";
  } else if (hist.ok) {
    lpChangeBps = bpsChange(hist.value[1], Lnow);
    lpMethod = "active liquidity L at the current tick (also moves when price crosses ticks)";
  }

  let quoteReserveChangeBps: number | null = null;
  if (hist.ok && quoteSide !== null) {
    const past = v3VirtualReserves(hist.value[0][0], hist.value[1]);
    const now = v3VirtualReserves(sqrtNow, Lnow);
    quoteReserveChangeBps = bpsChange(quoteSide === 0 ? past.reserve0 : past.reserve1, quoteSide === 0 ? now.reserve0 : now.reserve1);
  }

  const method: OvernightPoolDelta["method"] = hist.ok ? "historical-state" : rawLogs.ok ? "event-logs" : "unavailable";
  const flow = swapCount !== null ? `${swapCount} swaps, ${lpEvents} LP mint/burn events` : "event logs unavailable";
  const note = hist.ok
    ? `slot0()/liquidity() at block #${fromBlock} vs latest; ${flow}.`
    : rawLogs.ok
      ? swapCount === 0
        ? `0 swaps since block #${fromBlock} — price static overnight (state pruned; derived from event logs).`
        : `${flow} since block #${fromBlock}; price Δ measured from the price before the first overnight swap (state pruned; derived from event logs).`
      : "Historical state pruned and event logs unavailable on public RPC.";
  return {
    method, hours: OVERNIGHT_HOURS, fromBlock: fromBlock.toString(),
    reserve0ChangeBps: lpChangeBps, lpChangeBps, lpMethod, quoteReserveChangeBps,
    priceChangeBps, priceOrientation: orientation(token0, token1, quoteSide),
    swapCount, token0Volume, quoteVolume, note,
  };
}

/* ───────────────────────────── Pool discovery ───────────────────────────── */

export interface PoolCandidate {
  address: string;
  kind: PoolSnapshot["kind"];
  /** e.g. "Aerodrome volatile", "Aerodrome Slipstream CL (tick spacing 100)", "Uniswap v3 0.30%" */
  venue: string;
  factory: string;
  quote: string;
  quoteSymbol: string;
  quoteDecimals: number;
  /** quote.balanceOf(pool) — real tokens held across all ranges (raw units). */
  quoteBalance: string;
}

interface VenueProbe {
  kind: PoolSnapshot["kind"];
  venue: string;
  factory: Address;
  call: { address: Address; abi: readonly unknown[]; functionName: "getPool"; args: readonly unknown[] };
}

const g = globalThis as typeof globalThis & { __kestrelTickSpacings?: Map<string, { at: number; value: number[] }>; __kestrelRhV3Factory?: Address };
const tickSpacingCache = (g.__kestrelTickSpacings ??= new Map());

async function slipstreamTickSpacings(factory: Address): Promise<number[]> {
  const hit = tickSpacingCache.get(factory);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
  try {
    const ts = await getPublicClientForChain(8453).readContract({ address: factory, abi: SLIPSTREAM_FACTORY_ABI, functionName: "tickSpacings" });
    const value = ts.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (value.length) {
      tickSpacingCache.set(factory, { at: Date.now(), value });
      return value;
    }
  } catch {
    /* fall back to the known set */
  }
  return [...BASE_POOL_VENUES.slipstreamTickSpacings];
}

async function rhV3Factory(): Promise<Address> {
  if (g.__kestrelRhV3Factory) return g.__kestrelRhV3Factory;
  const f = await getPublicClientForChain(4663).readContract({ address: CONTRACTS.robinhood.vibesUniswapV3Pool, abi: UNISWAP_V3_POOL_ABI, functionName: "factory" });
  g.__kestrelRhV3Factory = getAddress(f);
  return g.__kestrelRhV3Factory;
}

async function venueProbes(chainId: ChainId, token: Address, quote: Address): Promise<VenueProbe[]> {
  const probes: VenueProbe[] = [];
  const v3 = (factory: Address) => {
    for (const fee of UNISWAP_V3_FEE_TIERS) {
      probes.push({ kind: "uniswap-v3", venue: `Uniswap v3 ${(fee / 10_000).toFixed(2)}%`, factory, call: { address: factory, abi: UNISWAP_V3_FACTORY_FEE_ABI, functionName: "getPool", args: [token, quote, fee] } });
    }
  };
  if (chainId === 4663) {
    v3(await rhV3Factory());
    return probes;
  }
  const aero = BASE_POOL_VENUES.aerodromeFactory;
  for (const stable of [false, true]) {
    probes.push({ kind: "aerodrome-v2", venue: venueLabel({ kind: "aerodrome-v2", stable }), factory: aero, call: { address: aero, abi: AERODROME_FACTORY_ABI, functionName: "getPool", args: [token, quote, stable] } });
  }
  const spacings = await Promise.all(BASE_POOL_VENUES.slipstreamFactories.map((f) => slipstreamTickSpacings(f)));
  BASE_POOL_VENUES.slipstreamFactories.forEach((factory, i) => {
    for (const ts of spacings[i]) {
      probes.push({ kind: "aerodrome-cl", venue: venueLabel({ kind: "aerodrome-cl", stable: false, tickSpacing: ts }), factory, call: { address: factory, abi: SLIPSTREAM_FACTORY_ABI, functionName: "getPool", args: [token, quote, ts] } });
    }
  });
  v3(BASE_POOL_VENUES.uniswapV3Factory);
  return probes;
}

/**
 * Every pool pairing `token` with each quote asset across the scanned venues — Base: Aerodrome v2 volatile +
 * stable, Aerodrome Slipstream CL (every enabled tick spacing on both CL factories) and Uniswap v3 (all fee
 * tiers); Robinhood Chain: Uniswap v3 (all fee tiers) — ranked by the quote asset actually held by the pool.
 * Throws on RPC failure (callers decide; an RPC error is NOT "no pool").
 */
export async function discoverPools(chainId: ChainId, token: Address, quotes?: Address[]): Promise<PoolCandidate[]> {
  const quoteList = (quotes ?? QUOTE_ASSETS[chainId].map((q) => q.address as Address)).filter((q) => q.toLowerCase() !== token.toLowerCase());
  const key = `pools:discover:v1:${chainId}:${token.toLowerCase()}:${quoteList.map((q) => q.toLowerCase().slice(2, 8)).join(",")}`;
  return cached(key, 300, async () => {
    const client = getPublicClientForChain(chainId);
    const probes = (await Promise.all(quoteList.map(async (q) => (await venueProbes(chainId, token, q)).map((p) => ({ ...p, quote: q }))))).flat();
    const res = (await client.multicall({ allowFailure: true, contracts: probes.map((p) => p.call) as never[] })) as { status: "success" | "failure"; result?: unknown }[];
    const found = new Map<string, (typeof probes)[number]>();
    res.forEach((r, i) => {
      const addr = r.status === "success" && typeof r.result === "string" ? r.result : ZERO;
      if (addr.toLowerCase() !== ZERO && !found.has(addr.toLowerCase())) found.set(addr.toLowerCase(), probes[i]);
    });
    if (!found.size) return [];
    const entries = [...found.entries()];
    const bals = await client.multicall({
      allowFailure: true,
      contracts: entries.map(([addr, p]) => ({ address: p.quote, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [getAddress(addr)] as const })),
    });
    const out: PoolCandidate[] = entries.map(([addr, p], i) => {
      const qa = QUOTE_ASSETS[chainId].find((q) => q.address.toLowerCase() === p.quote.toLowerCase());
      const b = bals[i];
      return {
        address: getAddress(addr),
        kind: p.kind,
        venue: p.venue,
        factory: p.factory,
        quote: p.quote,
        quoteSymbol: qa?.symbol ?? "?",
        quoteDecimals: qa?.decimals ?? 18,
        quoteBalance: b.status === "success" ? (b.result as bigint).toString() : "0",
      };
    });
    // Rank within each quote asset by depth; quotes keep the caller's order (never compare WETH vs USDC raw units).
    const rank = (q: string) => quoteList.findIndex((x) => x.toLowerCase() === q.toLowerCase());
    return out.sort((a, b) => rank(a.quote) - rank(b.quote) || (BigInt(b.quoteBalance) > BigInt(a.quoteBalance) ? 1 : BigInt(b.quoteBalance) < BigInt(a.quoteBalance) ? -1 : 0));
  });
}

/**
 * Deepest WETH pool for a token across every scanned venue (by WETH held). Returns a WETH pair only —
 * callers treat the other side as WETH. RPC failure → null (legacy contract); use discoverPools to tell apart.
 */
export async function discoverWethPool(chainId: ChainId, token: Address): Promise<Address | null> {
  const lower = token.toLowerCase();
  if (lower === wethAddress(chainId).toLowerCase()) return null;
  if (chainId === 8453 && lower === CONTRACTS.base.vibesToken.toLowerCase()) return CONTRACTS.base.vibesAerodromePool;
  if (chainId === 4663 && lower === CONTRACTS.robinhood.vibesToken.toLowerCase()) return CONTRACTS.robinhood.vibesUniswapV3Pool;
  try {
    const c = await discoverPools(chainId, token, [wethAddress(chainId) as Address]);
    return c[0] && BigInt(c[0].quoteBalance) > 0n ? getAddress(c[0].address) : null;
  } catch {
    return null;
  }
}

/**
 * Best exit pool for any token: the deepest WETH pair, else the deepest pair on the next quote asset
 * (USDC, USDbC, cbBTC on Base). For WETH itself this finds the deepest WETH/USDC pool.
 * Returns null when no venue has a pool; throws on RPC failure.
 */
export async function discoverBestPool(chainId: ChainId, token: Address): Promise<{ best: PoolCandidate; candidates: PoolCandidate[] } | null> {
  const weth = wethAddress(chainId) as Address;
  const order = [weth, ...QUOTE_ASSETS[chainId].map((q) => q.address as Address).filter((q) => q.toLowerCase() !== weth.toLowerCase())];
  const candidates = await discoverPools(chainId, token, order);
  const funded = candidates.filter((c) => BigInt(c.quoteBalance) > 0n);
  // Prefer the first quote asset (in order) whose deepest pool clears that asset's "thin" threshold, so a dust
  // WETH pair never hides a deep USDC pair; otherwise fall back to the first funded pool.
  const deepEnough = funded.find((c) => {
    const qa = QUOTE_ASSETS[chainId].find((q) => q.address.toLowerCase() === c.quote.toLowerCase());
    return qa ? BigInt(c.quoteBalance) >= qa.thin : false;
  });
  const best = deepEnough ?? funded[0] ?? null;
  return best ? { best, candidates } : null;
}
