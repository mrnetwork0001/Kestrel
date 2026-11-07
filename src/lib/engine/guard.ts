import { type Address } from "viem";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { getPublicClientForChain } from "@/lib/rpc";
import { errMsg } from "./chain-utils";
import { known7702Delegate } from "./eip7702";
import { scanTarget } from "./scan";
import { poolSides } from "./sides";
import { simulateExit } from "./sim";
import type { ChainId, Severity } from "./types";

export type Verdict = "ALLOW" | "WARN" | "BLOCK";
/** trade (default): the address is about to be traded/approved as a token or pool. counterparty: a wallet you send to. */
export type GuardIntent = "trade" | "counterparty";

const RANK: Record<Verdict, number> = { ALLOW: 0, WARN: 1, BLOCK: 2 };
const atLeast = (v: Verdict, floor: Verdict): Verdict => (RANK[v] >= RANK[floor] ? v : floor);

interface Override {
  severity: Severity;
  title: string;
  detail: string;
}

/**
 * Machine-readable pre-trade verdict for agents. Preview = free summary; full = everything.
 * Fails closed: no contract code → BLOCK for trade intent; any RPC uncertainty → at least WARN with
 * `status: "degraded"` and a retry hint — never ALLOW on missing data.
 */
export async function guardVerdict(chainId: ChainId, address: Address, tier: "preview" | "full", opts: { intent?: GuardIntent } = {}) {
  const intent: GuardIntent = opts.intent === "counterparty" ? "counterparty" : "trade";
  const client = getPublicClientForChain(chainId);
  const [scan, codeR] = await Promise.all([
    scanTarget(chainId, address, { useLlm: false }),
    client.getCode({ address }).then(
      (code) => ({ ok: true as const, code }),
      (e: unknown) => ({ ok: false as const, error: errMsg(e) })
    ),
  ]);
  let verdict: Verdict = scan.score >= 65 ? "BLOCK" : scan.score >= 30 ? "WARN" : "ALLOW";
  const overrides: Override[] = [];
  let degraded = false;

  const insp = codeR.ok ? inspectRawBytecode(codeR.code) : null;
  if (!codeR.ok) {
    degraded = true;
    verdict = atLeast(verdict, "WARN");
    overrides.push({ severity: "warn", title: "Contract code could not be confirmed (RPC error) — verdict UNKNOWN", detail: `eth_getCode failed: ${codeR.error}. Retry before trading.` });
  } else if (insp && (!insp.isContract || insp.eip7702Delegate)) {
    const what = insp.eip7702Delegate
      ? `EIP-7702 delegated EOA (delegate ${insp.eip7702Delegate}${known7702Delegate(insp.eip7702Delegate) ? `, ${known7702Delegate(insp.eip7702Delegate)!.label}` : ", unknown delegator"})`
      : "no contract code (EOA or undeployed address)";
    if (intent === "trade") {
      verdict = "BLOCK";
      overrides.push({ severity: "critical", title: "Not a token or pool — no contract code", detail: `This address has ${what}. Swapping or approving against it cannot be a real token trade; check for a typo'd or poisoned address.` });
    } else {
      overrides.push({ severity: "info", title: "Counterparty is a wallet", detail: `This address has ${what}.` });
    }
  } else if (insp?.isContract && scan.target.kind === "wallet") {
    // The scan treated a contract as a wallet: its own code read failed. Incomplete — never ALLOW.
    degraded = true;
    verdict = atLeast(verdict, "WARN");
    overrides.push({ severity: "warn", title: "Scan incomplete — contract analysed as a wallet", detail: "The scan's code read failed, so contract risks were not inspected. Retry." });
  }
  if (scan.xray?.degraded) {
    degraded = true;
    verdict = atLeast(verdict, "WARN");
    overrides.push({ severity: "warn", title: "Bytecode X-Ray incomplete (RPC error)", detail: (scan.xray.degradedReasons ?? []).slice(0, 3).join("; ") || "An X-Ray RPC read failed." });
  }

  const ranked = [...scan.findings].sort((a, b) => b.points - a.points);
  const sides = scan.pool ? poolSides(scan.pool) : null;
  // Token scans exit the scanned token itself (even when it is a quote asset like USDC); pool scans exit the risky side.
  const pool = scan.pool;
  const tokenAddr = scan.target.kind === "token" ? scan.target.address.toLowerCase() : null;
  const targetSide: 0 | 1 | null = pool && tokenAddr ? (pool.token0.address.toLowerCase() === tokenAddr ? 0 : pool.token1.address.toLowerCase() === tokenAddr ? 1 : null) : null;
  const exitSide: 0 | 1 | null = targetSide !== null ? (targetSide === 0 ? 1 : 0) : (sides?.quoteSide ?? null);
  const sim = pool && exitSide !== null ? simulateExit(pool, { sellBpsOfReserve: 100, sellToken: (exitSide === 0 ? pool.token1 : pool.token0).address }) : null;
  const exitMeta = pool && exitSide !== null ? (exitSide === 0 ? pool.token0 : pool.token1) : null;
  const findingReasons = ranked.filter((f) => f.points > 0).map((f) => ({ severity: f.severity, title: f.title, ...(tier === "full" ? { detail: f.detail, points: f.points, evidence: f.link?.href ?? null } : {}) }));
  const overrideReasons = overrides.map((o) => ({ severity: o.severity, title: o.title, ...(tier === "full" ? { detail: o.detail, points: 0, evidence: null } : {}) }));
  const base = {
    verdict,
    status: degraded ? ("degraded" as const) : ("complete" as const),
    ...(degraded ? { retryAfterSec: 15 } : {}),
    intent,
    riskScore: scan.score,
    band: scan.band,
    target: scan.target,
    reasons: [...overrideReasons, ...findingReasons].slice(0, tier === "preview" ? 3 : 50),
    simulatedSlippage: sim ? { sellAmountRaw: sim.sellAmount, sellSymbol: sim.sellSymbol, receiveSymbol: sim.receiveSymbol, priceImpactBps: sim.priceImpactBps, note: `Selling 1% of the ${sim.sellSymbol} side into ${sim.receiveSymbol}` } : null,
    poolDepthWethRaw: scan.pool && sides && sides.wethSide !== null ? (sides.wethSide === 0 ? scan.pool.reserve0 : scan.pool.reserve1) : null,
    poolDepth: pool && exitMeta && exitSide !== null
      ? { pool: pool.address, venue: pool.venue ?? pool.kind, quoteSymbol: exitMeta.symbol, quoteDecimals: exitMeta.decimals, raw: exitSide === 0 ? pool.reserve0 : pool.reserve1, virtual: pool.reservesAreVirtual }
      : null,
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
          whale5pct: simulateExit(scan.pool, { sellBpsOfReserve: 100, whaleDumpBpsOfSupply: 500, sellToken: sim?.sellToken }),
          lp50: simulateExit(scan.pool, { sellBpsOfReserve: 100, lpPullBps: 5000, sellToken: sim?.sellToken }),
        }
      : null,
    flow: scan.flow,
    wallet: scan.wallet,
    escrow: scan.escrow,
  };
}
