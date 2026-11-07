import { type Address, getAddress, parseAbi, type PublicClient } from "viem";
import { CONTRACTS, PERMIT2_SPENDERS, SPENDERS, TRACKED_TOKENS } from "@/config/contracts";
import { ERC20_ABI, PERMIT2_ABI } from "@/lib/abis";
import { isRpcFailure } from "@/lib/engine/call-errors";
import { isUnlimited } from "@/lib/format";
import type { ApprovalExposure, WalletHolding } from "@/lib/engine/types";

const META_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const SAFE_ABI = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
/**
 * Calldata bytes per multicall chunk (~270 allowance calls ≈ 2M gas per eth_call). The curated matrix — 37 tokens ×
 * 51 spenders ≈ 1.9k ERC-20 allowance reads + 37 × 5 Permit2 sub-allowances — fits in ~8 eth_calls.
 */
const BATCH_BYTES = 60_000;
/** Curated lists are ordered by importance, so if they ever outgrow these caps the tail is what gets dropped. */
const MAX_CURATED_TOKENS = 48;
const MAX_CURATED_SPENDERS = 64;
/** Extra (token, spender) pairs are checked one-to-one (never crossed with the matrix), capped for sanity. */
const MAX_EXTRA_PAIRS = 400;
/** Distinct non-curated tokens pulled in by extra pairs (each costs symbol + decimals + balanceOf). */
const MAX_EXTRA_TOKENS = 64;

/** A (token, spender) pair to re-check on top of Kestrel's known Base spender list (e.g. spenders discovered overnight by /api/scan). */
export interface ExtraPair {
  token: string;
  spender: string;
  spenderName?: string;
  kind?: "erc20" | "permit2";
  discoveredOvernight?: boolean;
}

/** Fresh, uncached read of a Base address's approval exposure. Every uint256 is a decimal string. */
export interface LiveExposure {
  owner: string;
  chainId: 8453;
  block: string;
  timestamp: number;
  readAt: string;
  nativeBalance: string;
  holdings: WalletHolding[];
  approvals: ApprovalExposure[];
  pairsChecked: number;
  /** Set when `owner` is a Safe (getThreshold/getOwners answered). */
  safe: { threshold: number; owners: number } | null;
  /** True when `owner` has contract code (Safe, smart wallet, EIP-7702 delegate). */
  hasCode: boolean;
  /** True when that code is an EIP-7702 delegation designator (an EOA with delegated code). */
  eip7702: boolean;
  /**
   * Reads that FAILED for an RPC reason (after one retry). Those pairs are UNKNOWN — never "no approval":
   * a consumer must not say "Nothing to revoke" / "0 still live" while `complete` is false.
   */
  failed: { allowance: number; permit2: number; meta: number; balance: number };
  /** approvalKey() of every (token, spender) pair whose fresh allowance read failed (keep them selected; retry). */
  failedKeys: string[];
  /** false when any allowance, Permit2, balance or meta read failed. */
  complete: boolean;
}

type CallResult = { status: "success" | "failure"; result?: unknown; error?: unknown };

/** allowFailure multicall that re-reads (once) only the calls that failed for an RPC reason, at the same block. */
async function multicallRetry(client: PublicClient, contracts: readonly unknown[], blockNumber: bigint, batchSize?: number): Promise<CallResult[]> {
  if (!contracts.length) return [];
  const run = (cs: readonly unknown[]) =>
    client.multicall({ allowFailure: true, blockNumber, ...(batchSize ? { batchSize } : {}), contracts: cs as never[] }) as Promise<CallResult[]>;
  const res = await run(contracts).catch((e: unknown) => contracts.map((): CallResult => ({ status: "failure", error: e })));
  const bad = res.flatMap((r, i) => (isRpcFailure(r) ? [i] : []));
  if (bad.length) {
    const again = await run(bad.map((i) => contracts[i])).catch(() => null);
    if (again) bad.forEach((i, k) => (res[i] = again[k] ?? res[i]));
  }
  return res;
}

export function approvalKey(a: { kind: string; token: string; spender: string }) {
  return `${a.kind}:${a.token.toLowerCase()}:${a.spender.toLowerCase()}`;
}

/**
 * Reads ERC-20 allowances and Permit2 sub-allowances for `owner` on Base directly over RPC, pinned to one block.
 * Works for EOAs, Safes, smart wallets and EIP-7702 accounts alike, and bypasses every server cache so it doubles as
 * the post-rescue verification read.
 *
 * Coverage: the full curated matrix (TRACKED_TOKENS × SPENDERS, both importance-ordered), Permit2 sub-allowances of
 * every curated token for the routers that pull through Permit2 (PERMIT2_SPENDERS), plus every `extra` pair (e.g. the
 * wallet's own Approval/Permit logs from /api/scan) checked one-to-one — extra pairs are never crossed with the matrix,
 * so a long discovery list adds N reads, not N × tokens × spenders.
 */
export async function readLiveExposure(client: PublicClient, ownerIn: string, extra: ExtraPair[] = []): Promise<LiveExposure> {
  const owner = getAddress(ownerIn);
  const latest = await client.getBlock({ blockTag: "latest" });
  const blockNumber = latest.number;
  const permit2 = CONTRACTS.base.permit2;
  const lc = (a: string) => a.toLowerCase();

  // ── tokens: curated first (importance order), then tokens only seen in extra pairs ──
  const curatedTokens = dedupeAddrs(TRACKED_TOKENS[8453]).slice(0, MAX_CURATED_TOKENS);
  const tokenIndex = new Map<string, number>(curatedTokens.map((t, i) => [lc(t), i]));
  const tokens: Address[] = [...curatedTokens];
  const extraPairs = dedupePairs(extra.filter((e) => isAddr(e.token) && isAddr(e.spender))).slice(0, MAX_EXTRA_PAIRS);
  let extraTokens = 0;
  for (const e of extraPairs) {
    if (tokenIndex.has(lc(e.token)) || extraTokens >= MAX_EXTRA_TOKENS) continue;
    tokenIndex.set(lc(e.token), tokens.length);
    tokens.push(getAddress(e.token));
    extraTokens++;
  }

  // ── spenders: curated ERC-20 spenders; Permit2 pull-routers from PERMIT2_SPENDERS ──
  const names = new Map<string, string>();
  const curatedSpenders = dedupeSpenders(SPENDERS[8453]).slice(0, MAX_CURATED_SPENDERS);
  for (const s of curatedSpenders) names.set(lc(s.address), s.name);
  const p2Spenders = dedupeSpenders(PERMIT2_SPENDERS[8453]).filter((s) => lc(s.address) !== lc(permit2));
  for (const s of p2Spenders) if (!names.has(lc(s.address))) names.set(lc(s.address), s.name);
  for (const e of extraPairs) if (!names.has(lc(e.spender))) names.set(lc(e.spender), e.spenderName?.slice(0, 60) || "Unlabeled spender");

  // ── check lists: (tokenIdx, spender) ──
  type Check = { ti: number; spender: Address };
  const erc20Checks: Check[] = [];
  const erc20Seen = new Set<string>();
  const addCheck = (list: Check[], seen: Set<string>, ti: number | undefined, spender: string) => {
    if (ti === undefined) return;
    const k = `${ti}:${lc(spender)}`;
    if (seen.has(k)) return;
    seen.add(k);
    list.push({ ti, spender: getAddress(spender) });
  };
  curatedTokens.forEach((_, ti) => curatedSpenders.forEach((s) => addCheck(erc20Checks, erc20Seen, ti, s.address)));
  const p2Checks: Check[] = [];
  const p2Seen = new Set<string>();
  curatedTokens.forEach((_, ti) => p2Spenders.forEach((s) => addCheck(p2Checks, p2Seen, ti, s.address)));
  for (const e of extraPairs) {
    const ti = tokenIndex.get(lc(e.token));
    if (e.kind === "permit2") {
      if (lc(e.spender) !== lc(permit2)) addCheck(p2Checks, p2Seen, ti, e.spender);
    } else addCheck(erc20Checks, erc20Seen, ti, e.spender);
  }
  const discovered = new Set(extra.filter((e) => e.discoveredOvernight).map((e) => `${lc(e.token)}:${lc(e.spender)}`));

  const [nativeBalance, code, metaRes, balRes, allowRes, p2Res, safeRes] = await Promise.all([
    client.getBalance({ address: owner, blockNumber }),
    client.getCode({ address: owner, blockNumber }).catch(() => undefined),
    multicallRetry(
      client,
      tokens.flatMap((t) => [
        { address: t, abi: META_ABI, functionName: "symbol" as const },
        { address: t, abi: META_ABI, functionName: "decimals" as const },
      ]),
      blockNumber,
      BATCH_BYTES,
    ),
    multicallRetry(client, tokens.map((t) => ({ address: t, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [owner] as const })), blockNumber, BATCH_BYTES),
    multicallRetry(
      client,
      erc20Checks.map((c) => ({ address: tokens[c.ti], abi: ERC20_ABI, functionName: "allowance" as const, args: [owner, c.spender] as const })),
      blockNumber,
      BATCH_BYTES,
    ),
    multicallRetry(
      client,
      p2Checks.map((c) => ({ address: permit2, abi: PERMIT2_ABI, functionName: "allowance" as const, args: [owner, tokens[c.ti], c.spender] as const })),
      blockNumber,
      BATCH_BYTES,
    ),
    client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: [
        { address: owner, abi: SAFE_ABI, functionName: "getThreshold" as const },
        { address: owner, abi: SAFE_ABI, functionName: "getOwners" as const },
      ],
    }),
  ]);

  let metaFailed = 0;
  const metas = tokens.map((t, i) => {
    const sym = metaRes[i * 2];
    const dec = metaRes[i * 2 + 1];
    // decimals() unread for an RPC reason: the placeholder 18 must never be used to scale an amount silently.
    const unread = isRpcFailure(dec) || isRpcFailure(sym);
    if (unread) metaFailed++;
    return {
      address: t,
      symbol: sym?.status === "success" ? String(sym.result).slice(0, 24) : "TOKEN",
      decimals: dec?.status === "success" ? Number(dec.result) : 18,
      unread: isRpcFailure(dec),
    };
  });

  const failedKeys: string[] = [];
  const approvals: ApprovalExposure[] = [];
  let allowanceFailed = 0;
  erc20Checks.forEach((c, i) => {
    const r = allowRes[i];
    if (isRpcFailure(r)) {
      allowanceFailed++;
      failedKeys.push(approvalKey({ kind: "erc20", token: tokens[c.ti], spender: c.spender }));
      return;
    }
    if (r?.status !== "success" || (r.result as bigint) <= 0n) return;
    const m = metas[c.ti];
    const amt = r.result as bigint;
    approvals.push({
      token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: c.spender, spenderName: names.get(lc(c.spender)) ?? "Unlabeled spender",
      kind: "erc20", amount: amt.toString(), unlimited: isUnlimited(amt),
      discoveredOvernight: discovered.has(`${lc(m.address)}:${lc(c.spender)}`),
      ...(m.unread ? { tokenMetaUnread: true } : {}),
    });
  });
  const nowSec = Number(latest.timestamp);
  let p2Failed = 0;
  p2Checks.forEach((c, i) => {
    const r = p2Res[i];
    if (isRpcFailure(r)) {
      p2Failed++;
      failedKeys.push(approvalKey({ kind: "permit2", token: tokens[c.ti], spender: c.spender }));
      return;
    }
    if (r?.status !== "success") return;
    const [amount, expiration] = r.result as readonly [bigint, number, number];
    if (amount > 0n && Number(expiration) > nowSec) {
      const m = metas[c.ti];
      approvals.push({
        token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: c.spender, spenderName: `${names.get(lc(c.spender)) ?? "Unlabeled spender"} via Permit2`,
        kind: "permit2", amount: amount.toString(), unlimited: isUnlimited(amount), expiration: Number(expiration),
        discoveredOvernight: discovered.has(`${lc(m.address)}:${lc(c.spender)}`),
        ...(m.unread ? { tokenMetaUnread: true } : {}),
      });
    }
  });
  const balanceFailed = balRes.filter((r) => isRpcFailure(r)).length;

  const [thr, owners] = safeRes;
  const safe = thr?.status === "success" && owners?.status === "success" ? { threshold: Number(thr.result as bigint), owners: (owners.result as readonly Address[]).length } : null;

  return {
    owner,
    chainId: 8453,
    block: blockNumber.toString(),
    timestamp: nowSec,
    readAt: new Date().toISOString(),
    nativeBalance: nativeBalance.toString(),
    holdings: metas
      .map((m, i) => ({ token: m.address as string, symbol: m.symbol, decimals: m.decimals, balance: balRes[i]?.status === "success" ? (balRes[i].result as bigint).toString() : "0" }))
      .filter((h) => h.balance !== "0"),
    approvals,
    // Pairs actually answered (failed reads are NOT "checked").
    pairsChecked: erc20Checks.length + p2Checks.length - allowanceFailed - p2Failed,
    safe,
    hasCode: !!code && code !== "0x",
    eip7702: !!code && code.toLowerCase().startsWith("0xef0100"),
    failed: { allowance: allowanceFailed, permit2: p2Failed, meta: metaFailed, balance: balanceFailed },
    failedKeys,
    complete: allowanceFailed + p2Failed + metaFailed + balanceFailed === 0,
  };
}

function isAddr(a: unknown): a is string {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function dedupeAddrs(list: readonly string[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    if (!isAddr(a) || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(getAddress(a));
  }
  return out;
}

function dedupeSpenders<T extends { address: string; name: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.address.toLowerCase();
    if (!isAddr(s.address) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupePairs(list: readonly ExtraPair[]): ExtraPair[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.kind ?? "erc20"}:${p.token.toLowerCase()}:${p.spender.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
