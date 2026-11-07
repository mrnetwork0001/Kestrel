import { CONTRACTS } from "@/config/contracts";
import { ERC20_ABI } from "@/lib/abis";
import { basePublicClient, robinhoodPublicClient } from "@/lib/rpc";

export interface RibbonTelemetry {
  baseBlock: string | null;
  rhBlock: string | null;
  parity: "VERIFIED" | "DRIFT" | "UNKNOWN";
  deltaRaw: string | null;
  fetchedAt: string;
}

/** Lightweight live read for the persistent top ribbon (block heights + OFT 1:1 invariant). */
export async function getRibbonTelemetry(): Promise<RibbonTelemetry> {
  const [baseBlock, rhBlock, locked, rhSupply, rhReserve] = await Promise.allSettled([
    basePublicClient.getBlockNumber(),
    robinhoodPublicClient.getBlockNumber(),
    basePublicClient.readContract({ address: CONTRACTS.base.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.base.vibesBridgeAdapter] }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "totalSupply" }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.robinhood.vibesReserveAdapter] }),
  ]);
  let parity: RibbonTelemetry["parity"] = "UNKNOWN";
  let deltaRaw: string | null = null;
  if (locked.status === "fulfilled" && rhSupply.status === "fulfilled" && rhReserve.status === "fulfilled") {
    const circ = rhSupply.value - rhReserve.value;
    const delta = locked.value >= circ ? locked.value - circ : circ - locked.value;
    deltaRaw = delta.toString();
    parity = delta === 0n ? "VERIFIED" : "DRIFT";
  }
  return {
    baseBlock: baseBlock.status === "fulfilled" ? baseBlock.value.toString() : null,
    rhBlock: rhBlock.status === "fulfilled" ? rhBlock.value.toString() : null,
    parity,
    deltaRaw,
    fetchedAt: new Date().toISOString(),
  };
}
