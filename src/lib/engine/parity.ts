import { CONTRACTS } from "@/config/contracts";
import { ERC20_ABI } from "@/lib/abis";
import { basePublicClient, robinhoodPublicClient } from "@/lib/rpc";
import { readPool } from "./pools";
import type { ParityReport, PoolSnapshot } from "./types";

/** Typical gas for a single-hop AMM swap; used only to express gas drag in ETH terms. */
const SWAP_GAS_UNITS = 150_000;

function vibesPerWeth(pool: PoolSnapshot | null, vibes: string): bigint {
  if (!pool) return 0n;
  // token1PerToken0 = VIBES per WETH when token0 is WETH
  return pool.token0.address.toLowerCase() === vibes.toLowerCase() ? BigInt(pool.token0PerToken1) : BigInt(pool.token1PerToken0);
}

/**
 * Live dual-RPC $VIBES LayerZero OFT parity + cross-venue spread.
 * Invariant: BaseAdapter.balanceOf == RH.totalSupply − RHReserveAdapter.balanceOf
 */
export async function getBridgeParity(opts: { overnight?: boolean } = {}): Promise<ParityReport> {
  const [baseBlock, rhBlock] = await Promise.all([
    basePublicClient.getBlock({ blockTag: "latest" }),
    robinhoodPublicClient.getBlock({ blockTag: "latest" }),
  ]);
  const [locked, rhSupply, rhReserve, basePool, rhPool, baseGas, rhGas] = await Promise.all([
    basePublicClient.readContract({ address: CONTRACTS.base.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.base.vibesBridgeAdapter], blockNumber: baseBlock.number }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: rhBlock.number }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.robinhood.vibesReserveAdapter], blockNumber: rhBlock.number }),
    readPool(8453, CONTRACTS.base.vibesAerodromePool, opts).catch(() => null),
    readPool(4663, CONTRACTS.robinhood.vibesUniswapV3Pool, opts).catch(() => null),
    basePublicClient.getGasPrice().catch(() => 0n),
    robinhoodPublicClient.getGasPrice().catch(() => 0n),
  ]);

  const circulating = rhSupply - rhReserve;
  const delta = locked >= circulating ? locked - circulating : circulating - locked;
  const baseP = vibesPerWeth(basePool, CONTRACTS.base.vibesToken);
  const rhP = vibesPerWeth(rhPool, CONTRACTS.robinhood.vibesToken);
  const spreadBps = baseP > 0n && rhP > 0n ? Number(((rhP - baseP) * 10_000n) / baseP) : null;
  const feeDragBps = basePool && rhPool ? basePool.feeBps + rhPool.feeBps : null;
  const netEdgeBps = spreadBps !== null && feeDragBps !== null ? Math.abs(spreadBps) - feeDragBps : null;
  const gwei = (wei: bigint) => {
    const scaled = (wei * 1000n) / 1_000_000_000n;
    return `${scaled / 1000n}.${(scaled % 1000n).toString().padStart(3, "0")}`;
  };

  return {
    base: { chainId: 8453, number: baseBlock.number.toString(), timestamp: Number(baseBlock.timestamp) },
    robinhood: { chainId: 4663, number: rhBlock.number.toString(), timestamp: Number(rhBlock.timestamp) },
    lockedOnBase: locked.toString(),
    rhTotalSupply: rhSupply.toString(),
    rhReserve: rhReserve.toString(),
    rhCirculating: circulating.toString(),
    delta: delta.toString(),
    verified: delta === 0n,
    basePool,
    rhPool,
    baseVibesPerWeth: baseP.toString(),
    rhVibesPerWeth: rhP.toString(),
    spreadBps,
    // more VIBES per WETH => VIBES is cheaper on that venue
    cheaperVenue: spreadBps === null || spreadBps === 0 ? null : spreadBps > 0 ? "robinhood" : "base",
    feeDragBps,
    netEdgeBps,
    gas: {
      baseGwei: gwei(baseGas),
      rhGwei: gwei(rhGas),
      swapGasUnits: SWAP_GAS_UNITS,
      baseSwapCostWei: (baseGas * BigInt(SWAP_GAS_UNITS)).toString(),
      rhSwapCostWei: (rhGas * BigInt(SWAP_GAS_UNITS)).toString(),
    },
    fetchedAt: new Date().toISOString(),
  };
}
