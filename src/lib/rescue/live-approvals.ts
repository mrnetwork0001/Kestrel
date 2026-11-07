import { type Address, getAddress, parseAbi, type PublicClient } from "viem";
import { CONTRACTS, PERMIT2_SPENDERS, SPENDERS, TRACKED_TOKENS } from "@/config/contracts";
import { ERC20_ABI, PERMIT2_ABI } from "@/lib/abis";
import { isUnlimited } from "@/lib/format";
import type { ApprovalExposure, WalletHolding } from "@/lib/engine/types";

const META_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const SAFE_ABI = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
/** Calldata bytes per multicall chunk: the full token × spender matrix (~2.5k calls) fits in a handful of eth_calls. */
const BATCH_BYTES = 60_000;
const MAX_TOKENS = 64;
const MAX_SPENDERS = 80;

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
}

export function approvalKey(a: { kind: string; token: string; spender: string }) {
  return `${a.kind}:${a.token.toLowerCase()}:${a.spender.toLowerCase()}`;
}

/**
 * Reads ERC-20 allowances and Permit2 sub-allowances for `owner` on Base directly over RPC, pinned to one block.
 * Works for EOAs, Safes and smart wallets alike (the server scan classifies contract wallets as "contract" and
 * skips them), and bypasses every server cache so it doubles as the post-rescue verification read.
 */
export async function readLiveExposure(client: PublicClient, ownerIn: string, extra: ExtraPair[] = []): Promise<LiveExposure> {
  const owner = getAddress(ownerIn);
  const latest = await client.getBlock({ blockTag: "latest" });
  const blockNumber = latest.number;

  const tokenMap = new Map<string, Address>();
  for (const t of [...TRACKED_TOKENS[8453], ...extra.map((e) => e.token)]) tokenMap.set(t.toLowerCase(), getAddress(t));
  const tokens = [...tokenMap.values()].slice(0, MAX_TOKENS);

  const spenderMap = new Map<string, { name: string; address: Address }>();
  for (const s of SPENDERS[8453]) spenderMap.set(s.address.toLowerCase(), { name: s.name, address: getAddress(s.address) });
  for (const e of extra) {
    if (!spenderMap.has(e.spender.toLowerCase())) spenderMap.set(e.spender.toLowerCase(), { name: e.spenderName ?? "Unlabeled spender", address: getAddress(e.spender) });
  }
  const spenders = [...spenderMap.values()].slice(0, MAX_SPENDERS);
  const permit2 = CONTRACTS.base.permit2;
  // Permit2 sub-allowances: the spenders that pull through Permit2, plus any Permit2 pair the server scan reported.
  const p2Set = new Set([...PERMIT2_SPENDERS[8453].map((s) => s.address.toLowerCase()), ...extra.filter((e) => e.kind === "permit2").map((e) => e.spender.toLowerCase())]);
  const p2Spenders = spenders.filter((s) => s.address.toLowerCase() !== permit2.toLowerCase() && p2Set.has(s.address.toLowerCase()));
  const discovered = new Set(extra.filter((e) => e.discoveredOvernight).map((e) => `${e.token.toLowerCase()}:${e.spender.toLowerCase()}`));

  const [nativeBalance, code, metaRes, balRes, allowRes, p2Res, safeRes] = await Promise.all([
    client.getBalance({ address: owner, blockNumber }),
    client.getCode({ address: owner, blockNumber }).catch(() => undefined),
    client.multicall({
      allowFailure: true,
      blockNumber,
      batchSize: BATCH_BYTES,
      contracts: tokens.flatMap((t) => [
        { address: t, abi: META_ABI, functionName: "symbol" as const },
        { address: t, abi: META_ABI, functionName: "decimals" as const },
      ]),
    }),
    client.multicall({ allowFailure: true, blockNumber, batchSize: BATCH_BYTES, contracts: tokens.map((t) => ({ address: t, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [owner] as const })) }),
    client.multicall({
      allowFailure: true,
      blockNumber,
      batchSize: BATCH_BYTES,
      contracts: tokens.flatMap((t) => spenders.map((s) => ({ address: t, abi: ERC20_ABI, functionName: "allowance" as const, args: [owner, s.address] as const }))),
    }),
    client.multicall({
      allowFailure: true,
      blockNumber,
      batchSize: BATCH_BYTES,
      contracts: tokens.flatMap((t) => p2Spenders.map((s) => ({ address: permit2, abi: PERMIT2_ABI, functionName: "allowance" as const, args: [owner, t, s.address] as const }))),
    }),
    client.multicall({
      allowFailure: true,
      blockNumber,
      contracts: [
        { address: owner, abi: SAFE_ABI, functionName: "getThreshold" as const },
        { address: owner, abi: SAFE_ABI, functionName: "getOwners" as const },
      ],
    }),
  ]);

  const metas = tokens.map((t, i) => {
    const sym = metaRes[i * 2];
    const dec = metaRes[i * 2 + 1];
    return {
      address: t,
      symbol: sym?.status === "success" ? String(sym.result).slice(0, 24) : "TOKEN",
      decimals: dec?.status === "success" ? Number(dec.result) : 18,
    };
  });

  const approvals: ApprovalExposure[] = [];
  metas.forEach((m, ti) => {
    spenders.forEach((s, si) => {
      const r = allowRes[ti * spenders.length + si];
      if (r?.status === "success" && (r.result as bigint) > 0n) {
        const amt = r.result as bigint;
        approvals.push({
          token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: s.address, spenderName: s.name,
          kind: "erc20", amount: amt.toString(), unlimited: isUnlimited(amt),
          discoveredOvernight: discovered.has(`${m.address.toLowerCase()}:${s.address.toLowerCase()}`),
        });
      }
    });
  });
  const nowSec = Number(latest.timestamp);
  metas.forEach((m, ti) => {
    p2Spenders.forEach((s, si) => {
      const r = p2Res[ti * p2Spenders.length + si];
      if (r?.status !== "success") return;
      const [amount, expiration] = r.result as readonly [bigint, number, number];
      if (amount > 0n && Number(expiration) > nowSec) {
        approvals.push({
          token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: s.address, spenderName: `${s.name} via Permit2`,
          kind: "permit2", amount: amount.toString(), unlimited: isUnlimited(amount), expiration: Number(expiration), discoveredOvernight: false,
        });
      }
    });
  });

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
    pairsChecked: tokens.length * spenders.length + tokens.length * p2Spenders.length,
    safe,
    hasCode: !!code && code !== "0x",
    eip7702: !!code && code.toLowerCase().startsWith("0xef0100"),
  };
}
