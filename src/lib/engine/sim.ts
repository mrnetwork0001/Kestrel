import { priceImpactBps, quoteExactIn, simulateConstantProductShock } from "@/lib/amm-math";
import { poolSides } from "./sides";
import type { PoolSnapshot } from "./types";

/**
 * Coerce an untrusted numeric input (MCP args, query strings, sliders) to a clamped INTEGER.
 * NaN / ±Infinity / non-numeric → fallback; 12.5 → 13. Safe to pass to BigInt().
 */
export function toIntInRange(x: unknown, min: number, max: number, fallback: number): number {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : typeof x === "bigint" ? Number(x) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Pool fee as integer bps for BigInt math; fractional fees (e.g. 1.5 bps from older snapshots) round UP. */
function feeBpsOf(p: PoolSnapshot): number {
  const f = Number.isFinite(p.feePips) ? p.feePips / 100 : p.feeBps;
  return Number.isFinite(f) ? Math.min(9_999, Math.max(0, Math.ceil(f))) : 30;
}

export interface ExitSimulation {
  pool: string;
  chainId: number;
  sellToken: string;
  sellSymbol: string;
  receiveSymbol: string;
  sellAmount: string; // raw
  lpPullBps: number;
  whaleDumpAmount: string; // raw
  baselineOut: string; // raw
  postShockOut: string; // raw
  drawdownBps: number;
  priceImpactBps: number;
  feeBps: number;
  model: "constant-product" | "uniswap-v3-active-range";
  assumptions: string;
}

/**
 * Shared exit simulator used by the guard API, MCP `simulate_exit`, and (client-side) Chaos Lab.
 * Sells the risky side into the quote side (WETH / USDC … identified by ADDRESS, never by symbol).
 * When neither side is a known quote asset it sells token0 into token1. Numeric params may be untrusted:
 * they are rounded and clamped, never passed raw to BigInt().
 */
export function simulateExit(p: PoolSnapshot, params: { sellAmount?: bigint; sellBpsOfReserve?: number; lpPullBps?: number; whaleDumpBpsOfSupply?: number; whaleDumpAmount?: bigint; sellToken?: string }): ExitSimulation {
  const s = poolSides(p);
  // Explicit sellToken (e.g. the scanned token when it is itself the quote asset, like USDC) overrides the default side.
  const forced = params.sellToken?.toLowerCase();
  const sellSide: 0 | 1 = forced === p.token0.address.toLowerCase() ? 0 : forced === p.token1.address.toLowerCase() ? 1 : s.riskySide;
  const sellMeta = sellSide === 0 ? p.token0 : p.token1;
  const recvMeta = sellSide === 0 ? p.token1 : p.token0;
  const reserveToken = BigInt(sellSide === 0 ? p.reserve0 : p.reserve1);
  const reserveWeth = BigInt(sellSide === 0 ? p.reserve1 : p.reserve0);
  const feeBps = feeBpsOf(p);
  const sellBps = toIntInRange(params.sellBpsOfReserve, 0, 10_000, 100);
  const whaleBps = toIntInRange(params.whaleDumpBpsOfSupply, 0, 10_000, 0);
  const lpPullBps = toIntInRange(params.lpPullBps, 0, 9_500, 0);
  const sellAmount = typeof params.sellAmount === "bigint" && params.sellAmount >= 0n ? params.sellAmount : (reserveToken * BigInt(sellBps)) / 10_000n;
  const whaleDumpAmount = typeof params.whaleDumpAmount === "bigint" && params.whaleDumpAmount >= 0n ? params.whaleDumpAmount : (BigInt(sellMeta.totalSupply) * BigInt(whaleBps)) / 10_000n;
  const sim = simulateConstantProductShock({ reserveWeth, reserveToken, whaleDumpTokenAmount: whaleDumpAmount, lpPullBps, userTokenBalance: sellAmount, feeBps });
  return {
    pool: p.address,
    chainId: p.chainId,
    sellToken: sellMeta.address,
    sellSymbol: sellMeta.symbol,
    receiveSymbol: recvMeta.symbol,
    sellAmount: sellAmount.toString(),
    lpPullBps,
    whaleDumpAmount: whaleDumpAmount.toString(),
    baselineOut: sim.baselineExitWeth.toString(),
    postShockOut: sim.postShockExitWeth.toString(),
    drawdownBps: sim.drawdownBps,
    priceImpactBps: priceImpactBps(sellAmount, reserveToken, reserveWeth, feeBps),
    feeBps,
    model: p.reservesAreVirtual ? "uniswap-v3-active-range" : "constant-product",
    assumptions: p.reservesAreVirtual
      ? `Exact concentrated-liquidity swap math within the current active liquidity L (virtual reserves) of this ${p.venue ?? "CL"} pool; assumes no tick crossings — real depth beyond the range may differ.`
      : `Exact constant-product (x·y=k) math on live getReserves() with the pool's live fee.${p.stable ? " Stable pools use a flatter curve near peg, so this overstates their impact." : ""}`,
  };
}

export { quoteExactIn };
