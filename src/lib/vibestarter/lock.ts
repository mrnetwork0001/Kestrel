import { type Address, type Hex, getAddress } from "viem";
import { cached } from "@/lib/cache";
import { getPublicClientForChain } from "@/lib/rpc";
import { isRpcFailure } from "@/lib/engine/call-errors";
import { VS_LP_LOCKER_ABI, VS_LP_TOKEN_ABI, VS_ROUTER_ABI, LP_STATUS_LABELS } from "./abis";
import { vibestarterConfig } from "./addresses";
import type { LpLockProof, LpLockStatus } from "@/lib/engine/types";

/**
 * Proof-of-Lock: verifies a Vibestarter raise's "permanent LP" ON-CHAIN instead of inferring it from
 * escrow.lpCreated().
 *
 * Mechanics (Sourcify VibesLPLockerV2 / VibesLPFeeClaimer): at finalization the router calls
 * lockerV2.createAndLockLP(), which adds Aerodrome liquidity, clones a VibesLPFeeClaimer (EIP-1167, no
 * transfer / withdraw / admin path) and moves ALL minted LP into it. `verifyLPLocked(campaign)` returns
 * (locked, heldBalance) from the claimer. The locked share = heldBalance / pool LP totalSupply is the
 * fraction of the pool that can never be pulled ("rug floor").
 */

export type { LpLockProof, LpLockStatus };

const eip1167 = (impl: string) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

function empty(chainId: number, status: LpLockStatus, note: string): LpLockProof {
  return {
    status,
    chainId,
    locker: null,
    lockerVersion: null,
    pool: null,
    feeClaimer: null,
    claimerIsImmutableClone: null,
    lpLocked: null,
    lpTotalSupply: null,
    lockedShareBps: null,
    unlockedShareBps: null,
    ethPaired: null,
    tokensPaired: null,
    lockedAt: null,
    routerLpStatus: null,
    routerLpStatusLabel: null,
    lockTx: null,
    note,
    block: null,
  };
}

/** Verifies the LP lock transaction receipt succeeded and emitted a log from the locker (or router). */
async function verifyLockTx(chainId: number, hash: string, locker: string, router: string): Promise<LpLockProof["lockTx"]> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  try {
    return await cached(`vs-locktx:${chainId}:${hash.toLowerCase()}`, 86_400, async () => {
      const r = await getPublicClientForChain(chainId).getTransactionReceipt({ hash: hash as Hex });
      const fromLocker = r.logs.some((l) => l.address.toLowerCase() === locker.toLowerCase());
      const fromRouter = r.logs.some((l) => l.address.toLowerCase() === router.toLowerCase());
      const verified = r.status === "success" && (fromLocker || fromRouter);
      return {
        hash,
        verified,
        block: r.blockNumber.toString(),
        note: verified
          ? `Receipt status success at block ${r.blockNumber}; ${fromLocker ? "locker" : "router"} emitted the lock event.`
          : r.status !== "success"
            ? "Receipt reverted."
            : "Receipt has no locker/router log.",
      };
    });
  } catch {
    return { hash, verified: false, block: null, note: "Receipt not retrievable from the public RPC right now." };
  }
}

/**
 * Reads the on-chain LP lock for one escrow (tries every known locker; V2 first). `token` enables the
 * router lpStatus cross-check; `lockTxHash` (from Vibestarter's detail API) is independently verified.
 */
export async function readLpLock(chainId: number, escrow: Address, opts: { token?: Address | null; lockTxHash?: string | null } = {}): Promise<LpLockProof> {
  const cfg = vibestarterConfig(chainId);
  const c = getPublicClientForChain(chainId);
  try {
    const block = await c.getBlockNumber();
    const routerStatus = opts.token
      ? await c.readContract({ address: cfg.router, abi: VS_ROUTER_ABI, functionName: "lpStatus", args: [opts.token], blockNumber: block }).catch(() => null)
      : null;
    const routerLpStatus = routerStatus === null ? null : Number(routerStatus);
    const routerLpStatusLabel = routerLpStatus === null ? null : (LP_STATUS_LABELS[routerLpStatus] ?? `Unknown(${routerLpStatus})`);

    /** Lockers whose verifyLPLocked/hasRescuedLP read failed for an RPC reason: their answer is UNKNOWN. */
    const unread: string[] = [];
    for (const locker of cfg.lpLockers) {
      const [ver, claimer, rescued] = await c.multicall({
        allowFailure: true,
        blockNumber: block,
        contracts: [
          { address: locker.address, abi: VS_LP_LOCKER_ABI, functionName: "verifyLPLocked", args: [escrow] },
          { address: locker.address, abi: VS_LP_LOCKER_ABI, functionName: "campaignToFeeClaimer", args: [escrow] },
          { address: locker.address, abi: VS_LP_LOCKER_ABI, functionName: "hasRescuedLP", args: [escrow] },
        ],
      });
      if (rescued.status === "success" && rescued.result) {
        return {
          ...empty(chainId, "rescued", `LP creation failed and was recorded as a rescue in ${locker.version.toUpperCase()} locker — no permanent LP exists for this raise.`),
          locker: locker.address,
          lockerVersion: locker.version,
          routerLpStatus,
          routerLpStatusLabel,
          block: block.toString(),
        };
      }
      if (isRpcFailure(ver) || isRpcFailure(rescued)) {
        unread.push(locker.version.toUpperCase());
        continue;
      }
      if (ver.status !== "success" || !ver.result[0]) continue;
      const heldBalance = ver.result[1];
      const pos = await c.readContract({ address: locker.address, abi: VS_LP_LOCKER_ABI, functionName: "getLockedPosition", args: [escrow], blockNumber: block });
      const claimerAddr = claimer.status === "success" && claimer.result !== "0x0000000000000000000000000000000000000000" ? claimer.result : null;
      const [lpSupply, code] = await Promise.all([
        c.readContract({ address: pos.pool, abi: VS_LP_TOKEN_ABI, functionName: "totalSupply", blockNumber: block }).catch(() => null),
        claimerAddr ? c.getCode({ address: claimerAddr, blockNumber: block }).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      // rounded to the nearest bp (BigInt): VIBES/WETH 38,236.41 / 38,619.82 LP → 9901 = 99.01%
      const lockedShareBps = lpSupply && lpSupply > 0n ? Number((heldBalance * 10_000n + lpSupply / 2n) / lpSupply) : null;
      const isClone = cfg.feeClaimerImpl && code ? code.toLowerCase() === eip1167(cfg.feeClaimerImpl) : null;
      const lockTx = opts.lockTxHash ? await verifyLockTx(chainId, opts.lockTxHash, locker.address, cfg.router) : null;
      const pct = lockedShareBps != null ? `${(lockedShareBps / 100).toFixed(2)}%` : "an unknown share";
      return {
        status: "verified",
        chainId,
        locker: locker.address,
        lockerVersion: locker.version,
        pool: getAddress(pos.pool),
        feeClaimer: claimerAddr,
        claimerIsImmutableClone: isClone,
        lpLocked: heldBalance.toString(),
        lpTotalSupply: lpSupply?.toString() ?? null,
        lockedShareBps,
        unlockedShareBps: lockedShareBps != null ? Math.max(0, 10_000 - lockedShareBps) : null,
        ethPaired: pos.ethAmount.toString(),
        tokensPaired: pos.tokenAmount.toString(),
        lockedAt: Number(pos.timestamp),
        routerLpStatus,
        routerLpStatusLabel,
        lockTx,
        note:
          `verifyLPLocked() = true on ${locker.version.toUpperCase()} locker: ${pct} of the pool's LP supply is held by ` +
          (isClone ? "an immutable EIP-1167 VibesLPFeeClaimer clone (no transfer / withdraw / admin path) — permanent." : "the fee claimer."),
        block: block.toString(),
      };
    }
    // A failed read is not proof that no lock exists.
    if (unread.length) {
      return {
        ...empty(chainId, "unavailable", `Proof-of-Lock read failed on the ${unread.join(" + ")} locker (RPC error) — lock status UNKNOWN; retry shortly.`),
        routerLpStatus,
        routerLpStatusLabel,
        block: block.toString(),
      };
    }
    return {
      ...empty(chainId, "not-locked", routerLpStatus === 2 ? "Router reports LP rescued (creation failed)." : "No locker reports a locked LP position for this escrow."),
      routerLpStatus,
      routerLpStatusLabel,
      block: block.toString(),
    };
  } catch (e) {
    return empty(chainId, "unavailable", `Proof-of-Lock read failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
}

export interface LockedPositionsSummary {
  chainId: number;
  locker: string;
  positions: { token: string; pool: string; campaign: string; ethAmount: string; tokenAmount: string; lpAmount: string; timestamp: number }[];
  totalEthPaired: string;
  block: string;
}

/** Every position recorded in the live LP locker(s) of a chain (for the Pulse reconciliation). Cached 60 s. */
export function readLockedPositions(chainId: 8453 | 4663 = 8453): Promise<LockedPositionsSummary[]> {
  return cached(`vs-lockers:${chainId}`, 60, async () => {
    const cfg = vibestarterConfig(chainId);
    const c = getPublicClientForChain(chainId);
    const block = await c.getBlockNumber();
    const out: LockedPositionsSummary[] = [];
    const res = await c.multicall({
      allowFailure: true,
      blockNumber: block,
      contracts: cfg.lpLockers.map((l) => ({ address: l.address, abi: VS_LP_LOCKER_ABI, functionName: "getAllLockedPositions" as const })),
    });
    res.forEach((r, i) => {
      if (r.status !== "success") return;
      const positions = (r.result as readonly { token: Address; pool: Address; tokenAmount: bigint; ethAmount: bigint; lpAmount: bigint; timestamp: bigint; campaign: Address }[]).map((p) => ({
        token: p.token,
        pool: p.pool,
        campaign: p.campaign,
        ethAmount: p.ethAmount.toString(),
        tokenAmount: p.tokenAmount.toString(),
        lpAmount: p.lpAmount.toString(),
        timestamp: Number(p.timestamp),
      }));
      const total = positions.reduce((s, p) => s + BigInt(p.ethAmount), 0n);
      out.push({ chainId, locker: cfg.lpLockers[i].address, positions, totalEthPaired: total.toString(), block: block.toString() });
    });
    return out;
  });
}
