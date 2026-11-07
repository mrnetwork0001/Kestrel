import { type Address } from "viem";
import { scanTarget } from "./scan";
import { simulateExit } from "./sim";
import type { ChainId } from "./types";

export type Verdict = "ALLOW" | "WARN" | "BLOCK";

/** Machine-readable pre-trade verdict for agents. Preview = free summary; full = everything. */
export async function guardVerdict(chainId: ChainId, address: Address, tier: "preview" | "full") {
  const scan = await scanTarget(chainId, address, { useLlm: false });
  const verdict: Verdict = scan.score >= 65 ? "BLOCK" : scan.score >= 30 ? "WARN" : "ALLOW";
  const ranked = [...scan.findings].sort((a, b) => b.points - a.points);
  const sim = scan.pool ? simulateExit(scan.pool, { sellBpsOfReserve: 100 }) : null;
  const wethSide = scan.pool ? (scan.pool.token0.symbol.toUpperCase().includes("WETH") ? scan.pool.reserve0 : scan.pool.token1.symbol.toUpperCase().includes("WETH") ? scan.pool.reserve1 : null) : null;
  const base = {
    verdict,
    riskScore: scan.score,
    band: scan.band,
    target: scan.target,
    reasons: ranked.filter((f) => f.points > 0).slice(0, tier === "preview" ? 3 : 50).map((f) => ({ severity: f.severity, title: f.title, ...(tier === "full" ? { detail: f.detail, points: f.points, evidence: f.link?.href ?? null } : {}) })),
    simulatedSlippage: sim ? { sellAmountRaw: sim.sellAmount, sellSymbol: sim.sellSymbol, priceImpactBps: sim.priceImpactBps, note: "Selling 1% of pool-side depth" } : null,
    poolDepthWethRaw: wethSide,
    bridgeParity: scan.parity ? { verified: scan.parity.verified, deltaRaw: scan.parity.delta, spreadBps: scan.parity.spreadBps } : null,
    chainId,
    blockNumber: scan.block.number,
    timestamp: new Date(scan.block.timestamp * 1000).toISOString(),
    tier,
  };
  if (tier === "preview") return base;
  return {
    ...base,
    findings: scan.findings,
    xray: scan.xray,
    pool: scan.pool ? { ...scan.pool } : null,
    stress: scan.pool
      ? {
          whale5pct: simulateExit(scan.pool, { sellBpsOfReserve: 100, whaleDumpBpsOfSupply: 500 }),
          lp50: simulateExit(scan.pool, { sellBpsOfReserve: 100, lpPullBps: 5000 }),
        }
      : null,
    flow: scan.flow,
    wallet: scan.wallet,
    escrow: scan.escrow,
  };
}
