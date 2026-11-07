import { type Address, zeroAddress } from "viem";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { cached } from "@/lib/cache";
import { getPublicClientForChain } from "@/lib/rpc";
import { errMsg } from "./chain-utils";
import { known7702Delegate } from "./eip7702";
import { scanDegradedReasons, scanTarget } from "./scan";
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

export const GUARD_RETRY_AFTER_SEC = 15;

/** Normalize an untrusted intent value. Absent → "trade"; anything other than trade/counterparty → null (HTTP 400). */
export function parseGuardIntent(input: unknown): GuardIntent | null {
  if (input === undefined || input === null || input === "") return "trade";
  return input === "trade" || input === "counterparty" ? input : null;
}

/** Verdict when the address could not be classified at all (the scan threw): UNKNOWN → WARN, never ALLOW. */
function unavailableVerdict(chainId: ChainId, address: Address, tier: "preview" | "full", intent: GuardIntent, error: string) {
  return {
    verdict: "WARN" as Verdict,
    status: "degraded" as const,
    retryAfterSec: GUARD_RETRY_AFTER_SEC,
    scanError: error,
    intent,
    riskScore: null,
    band: null,
    target: { address, chainId, kind: null, label: "" },
    reasons: [{ severity: "warn" as Severity, title: "Live scan failed — verdict UNKNOWN", ...(tier === "full" ? { detail: `${error}. Do not trade on this verdict; retry in ${GUARD_RETRY_AFTER_SEC}s.`, points: 0, evidence: null } : {}) }],
    simulatedSlippage: null,
    poolDepthWethRaw: null,
    poolDepth: null,
    bridgeParity: null,
    chainId,
    blockNumber: null,
    timestamp: new Date().toISOString(),
    tier,
  };
}

/** Carries a degraded verdict out of cached() so it is returned but never stored. */
class UncacheableVerdict extends Error {
  constructor(readonly result: GuardVerdictResult) {
    super("degraded verdict — not cached");
  }
}

export type GuardVerdictResult = Awaited<ReturnType<typeof guardVerdict>>;

/**
 * guardVerdict behind the shared 30 s cache. Degraded verdicts (any RPC uncertainty) are returned but never
 * cached, so a transient failure is not served to other callers. Use this from routes / MCP.
 */
export async function cachedGuardVerdict(chainId: ChainId, address: Address, tier: "preview" | "full", opts: { intent?: GuardIntent } = {}): Promise<GuardVerdictResult> {
  const intent = parseGuardIntent(opts.intent) ?? "trade";
  try {
    return await cached(`guard:${tier}:v2:${chainId}:${address.toLowerCase()}:${intent}`, 30, async () => {
      const r = await guardVerdict(chainId, address, tier, { intent });
      if (r.status !== "complete") throw new UncacheableVerdict(r);
      return r;
    });
  } catch (e) {
    if (e instanceof UncacheableVerdict) return e.result;
    throw e;
  }
}

/**
 * Machine-readable pre-trade verdict for agents. Preview = free summary; full = everything.
 * Fails closed: no contract code → BLOCK for trade intent; any RPC uncertainty → at least WARN with
 * `status: "degraded"` and a retry hint — never ALLOW on missing data.
 */
export async function guardVerdict(chainId: ChainId, address: Address, tier: "preview" | "full", opts: { intent?: GuardIntent } = {}) {
  const intent: GuardIntent = opts.intent === "counterparty" ? "counterparty" : "trade";
  if (address.toLowerCase() === zeroAddress) {
    const r = unavailableVerdict(chainId, address, tier, intent, "zero address");
    return { ...r, verdict: "BLOCK" as Verdict, status: "complete" as const, retryAfterSec: undefined, scanError: undefined, reasons: [{ severity: "critical" as Severity, title: "Zero address — not a token, pool, wallet or escrow", ...(tier === "full" ? { detail: "Sending or approving to 0x000…000 burns or reverts. Nothing to trade.", points: 0, evidence: null } : {}) }] };
  }
  const client = getPublicClientForChain(chainId);
  const [scanR, codeR] = await Promise.all([
    scanTarget(chainId, address, { useLlm: false }).then(
      (scan) => ({ ok: true as const, scan }),
      (e: unknown) => ({ ok: false as const, error: errMsg(e) })
    ),
    client.getCode({ address }).then(
      (code) => ({ ok: true as const, code }),
      (e: unknown) => ({ ok: false as const, error: errMsg(e) })
    ),
  ]);
  if (!scanR.ok) {
    // No classification at all. If the code read DID succeed and shows no code, trade intent is still a hard BLOCK.
    const r = unavailableVerdict(chainId, address, tier, intent, `Scan failed: ${scanR.error}`);
    const noCode = codeR.ok && !inspectRawBytecode(codeR.code).isContract && !inspectRawBytecode(codeR.code).eip7702Delegate;
    return noCode && intent === "trade" ? { ...r, verdict: "BLOCK" as Verdict, reasons: [{ severity: "critical" as Severity, title: "Not a token or pool — no contract code" }, ...r.reasons] } : r;
  }
  const scan = scanR.scan;
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
    const acct = scan.wallet?.account;
    if (acct && acct.kind !== "eoa" && acct.kind !== "eip7702") {
      // Smart-contract wallet (Safe / Coinbase Smart Wallet / ERC-4337): a wallet, not a token or pool.
      if (intent === "trade") {
        verdict = "BLOCK";
        overrides.push({ severity: "critical", title: `Not a token or pool — ${acct.label}`, detail: "This address is a smart-contract wallet. Swapping or approving against it cannot be a real token trade; check for a typo'd or poisoned address." });
      } else {
        overrides.push({ severity: "info", title: `Counterparty is a smart-contract wallet (${acct.label})`, detail: "Account classified from live reads (Safe getThreshold/getOwners, ERC-4337 entryPoint, Coinbase Smart Wallet implementation)." });
      }
    } else {
      // A contract scanned as a wallet with no account classification: contract risks were not inspected.
      degraded = true;
      verdict = atLeast(verdict, "WARN");
      overrides.push({ severity: "warn", title: "Scan incomplete — contract analysed as a wallet", detail: "Contract risks were not inspected. Retry." });
    }
  }
  // The logic behind an unresolved DELEGATECALL forwarder was never scanned: never ALLOW.
  if (scan.xray?.unresolvedDelegatecall) {
    verdict = atLeast(verdict, "WARN");
    overrides.push({ severity: "warn", title: "Unresolved delegatecall proxy — logic UNKNOWN", detail: "The contract forwards to logic Kestrel could not resolve; its privileged entry points were not inspected." });
  }
  // Any failed live read inside the scan (X-Ray, pool discovery, exit pool, flow, parity) → UNKNOWN parts → never ALLOW.
  // Approval coverage is only relevant when the target is the subject wallet, not a token/pool/counterparty verdict.
  const incomplete = scanDegradedReasons(scan, { approvals: false });
  if (incomplete.length) {
    degraded = true;
    verdict = atLeast(verdict, "WARN");
    overrides.push({ severity: "warn", title: "Scan incomplete (RPC error) — parts of the verdict are UNKNOWN", detail: incomplete.slice(0, 3).join("; ") });
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
    ...(degraded ? { retryAfterSec: GUARD_RETRY_AFTER_SEC } : {}),
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
    bridgeParity: scan.parity
      ? {
          verdict: scan.parity.verdict ?? (scan.parity.verified ? "EXACT" : "IN_FLIGHT"),
          verified: scan.parity.verified,
          deltaRaw: scan.parity.delta,
          pendingPackets: scan.parity.pendingPackets ?? null,
          spreadBps: scan.parity.spreadBps,
          /** All-in: after pool fees, the live LayerZero fee and gas. */
          netEdgeBps: scan.parity.netEdgeBps,
        }
      : null,
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
