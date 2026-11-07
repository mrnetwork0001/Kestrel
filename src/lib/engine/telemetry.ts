import { CONTRACTS } from "@/config/contracts";
import { ERC20_ABI } from "@/lib/abis";
import { cached } from "@/lib/cache";
import { basePublicClient, robinhoodPublicClient } from "@/lib/rpc";
import { getBridgeParity } from "./parity";
import type { ParityVerdict } from "./types";

/**
 * Signed ribbon parity status:
 *  - VERIFIED: locked == circulating (Δ 0)
 *  - IN_FLIGHT / OVER_BACKED: locked > circulating (packets crossing / extra collateral) — holders are covered
 *  - BACKED: locked > circulating but the in-flight check could not be read in time — holders are still covered
 *  - DRIFT: circulating > locked, confirmed on a second pair of fresh reads (the UNBACKED case)
 *  - UNKNOWN: a read failed
 */
export type RibbonParityStatus = "VERIFIED" | "IN_FLIGHT" | "OVER_BACKED" | "BACKED" | "DRIFT" | "UNKNOWN";

export interface RibbonTelemetry {
  baseBlock: string | null;
  rhBlock: string | null;
  parity: RibbonParityStatus;
  /** Full parity-engine verdict when known (UNBACKED ⇔ parity "DRIFT"). */
  verdict?: ParityVerdict | null;
  /** locked − circulating, signed raw (>0 covered, <0 unbacked). */
  deltaSigned?: string | null;
  /** |locked − circulating| raw. */
  deltaRaw: string | null;
  fetchedAt: string;
  /** Wall-clock ms of each chain's head read through the server RPC fallback chain (null = failed). */
  rpcLatencyMs?: { base: number | null; robinhood: number | null };
}

/** Times a read; resolves to [value, ms]. Rejections propagate (Promise.allSettled handles them). */
async function timed<T>(p: Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const v = await p;
  return [v, Date.now() - t0];
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((ok) => (t = setTimeout(() => ok(null), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** locked − circulating at fresh blocks (both chains pinned to their own latest block). */
async function readSignedDelta(): Promise<bigint> {
  const [bn, rn] = await Promise.all([basePublicClient.getBlockNumber({ cacheTime: 0 }), robinhoodPublicClient.getBlockNumber({ cacheTime: 0 })]);
  const [l, s, r] = await Promise.all([
    basePublicClient.readContract({ address: CONTRACTS.base.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.base.vibesBridgeAdapter], blockNumber: bn }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: rn }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.robinhood.vibesReserveAdapter], blockNumber: rn }),
  ]);
  return l - (s - r);
}

/** Lightweight live read for the persistent top ribbon (block heights + OFT 1:1 invariant). */
export async function getRibbonTelemetry(): Promise<RibbonTelemetry> {
  const [baseBlock, rhBlock, locked, rhSupply, rhReserve] = await Promise.allSettled([
    timed(basePublicClient.getBlockNumber({ cacheTime: 0 })),
    timed(robinhoodPublicClient.getBlockNumber({ cacheTime: 0 })),
    basePublicClient.readContract({ address: CONTRACTS.base.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.base.vibesBridgeAdapter] }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "totalSupply" }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.robinhood.vibesReserveAdapter] }),
  ]);
  let parity: RibbonTelemetry["parity"] = "UNKNOWN";
  let verdict: ParityVerdict | null = null;
  let deltaRaw: string | null = null;
  let deltaSigned: bigint | null = null;
  if (locked.status === "fulfilled" && rhSupply.status === "fulfilled" && rhReserve.status === "fulfilled") {
    deltaSigned = locked.value - (rhSupply.value - rhReserve.value);
    if (deltaSigned < 0n) {
      // Never call unbacked supply on one unpinned pair of reads (cross-chain skew): confirm with a fresh pair.
      const again = await readSignedDelta().catch(() => null);
      deltaSigned = again;
    }
  }
  if (deltaSigned !== null) {
    deltaRaw = (deltaSigned < 0n ? -deltaSigned : deltaSigned).toString();
    if (deltaSigned === 0n) {
      parity = "VERIFIED";
      verdict = "EXACT";
    } else if (deltaSigned < 0n) {
      parity = "DRIFT";
      verdict = "UNBACKED";
    } else {
      // locked > circulating: in flight or over-backed. Reuse the parity engine's shared 15 s result to tell which.
      verdict = await withTimeout(cached("parity:lite", 15, () => getBridgeParity({ overnight: false })), 6_000)
        .then((p) => (p && p.verdict !== "UNBACKED" && p.verdict !== "EXACT" ? p.verdict : null))
        .catch(() => null);
      parity = verdict === "IN_FLIGHT" ? "IN_FLIGHT" : verdict === "OVER_BACKED" ? "OVER_BACKED" : "BACKED";
    }
  }
  return {
    baseBlock: baseBlock.status === "fulfilled" ? baseBlock.value[0].toString() : null,
    rhBlock: rhBlock.status === "fulfilled" ? rhBlock.value[0].toString() : null,
    parity,
    verdict,
    deltaSigned: deltaSigned?.toString() ?? null,
    deltaRaw,
    fetchedAt: new Date().toISOString(),
    rpcLatencyMs: { base: baseBlock.status === "fulfilled" ? baseBlock.value[1] : null, robinhood: rhBlock.status === "fulfilled" ? rhBlock.value[1] : null },
  };
}
