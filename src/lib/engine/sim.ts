import { priceImpactBps, quoteExactIn, simulateConstantProductShock } from "@/lib/amm-math";
import type { PoolSnapshot } from "./types";

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
 * Sells the non-WETH side of the pool into the WETH side.
 */
export function simulateExit(p: PoolSnapshot, params: { sellAmount?: bigint; sellBpsOfReserve?: number; lpPullBps?: number; whaleDumpBpsOfSupply?: number; whaleDumpAmount?: bigint }): ExitSimulation {
  const tokenIs0 = !p.token0.symbol.toUpperCase().includes("WETH") && p.token1.symbol.toUpperCase().includes("WETH");
  const sellMeta = tokenIs0 ? p.token0 : p.token1;
  const recvMeta = tokenIs0 ? p.token1 : p.token0;
  const reserveToken = BigInt(tokenIs0 ? p.reserve0 : p.reserve1);
  const reserveWeth = BigInt(tokenIs0 ? p.reserve1 : p.reserve0);
  const sellAmount = params.sellAmount ?? (reserveToken * BigInt(Math.max(0, Math.min(10_000, params.sellBpsOfReserve ?? 100)))) / 10_000n;
  const whaleDumpAmount = params.whaleDumpAmount ?? (BigInt(sellMeta.totalSupply) * BigInt(Math.max(0, Math.min(10_000, params.whaleDumpBpsOfSupply ?? 0)))) / 10_000n;
  const lpPullBps = Math.max(0, Math.min(9500, params.lpPullBps ?? 0));
  const sim = simulateConstantProductShock({ reserveWeth, reserveToken, whaleDumpTokenAmount: whaleDumpAmount, lpPullBps, userTokenBalance: sellAmount, feeBps: p.feeBps });
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
    priceImpactBps: priceImpactBps(sellAmount, reserveToken, reserveWeth, p.feeBps),
    feeBps: p.feeBps,
    model: p.reservesAreVirtual ? "uniswap-v3-active-range" : "constant-product",
    assumptions: p.reservesAreVirtual
      ? "Exact v3 swap math within the current active liquidity L (virtual reserves); assumes no tick crossings — real depth beyond the range may differ."
      : "Exact constant-product (x·y=k) math on live getReserves() with the pool's live fee.",
  };
}

export { quoteExactIn };
