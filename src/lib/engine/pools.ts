import { type Address, getAddress, parseEventLogs } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { AERODROME_FACTORY_ABI, AERODROME_POOL_ABI, UNISWAP_V3_FACTORY_ABI, UNISWAP_V3_POOL_ABI } from "@/lib/abis";
import { v2PricesScaled18, v3PricesScaled18, v3VirtualReserves } from "@/lib/amm-math";
import { getLogsClientForChain, getPublicClientForChain } from "@/lib/rpc";
import { blockHoursAgo, readTokenMeta } from "./chain-utils";
import type { ChainId, OvernightPoolDelta, PoolSnapshot } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
export const OVERNIGHT_HOURS = 8;

function bpsChange(before: bigint, after: bigint): number | null {
  if (before === 0n) return null;
  return Number(((after - before) * 10_000n) / before);
}

/**
 * Reads any Aerodrome/Uniswap-v2-style or Uniswap-v3-style pool live and computes
 * an overnight (8h) delta. Returns null if the address is not a recognizable pool.
 */
export async function readPool(chainId: ChainId, address: Address, opts: { overnight?: boolean } = {}): Promise<PoolSnapshot | null> {
  const client = getPublicClientForChain(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const blockNumber = latest.number;

  const [t0, t1, reserves, slot0, liq, fee, stable, factory] = await client.multicall({
    allowFailure: true,
    blockNumber,
    contracts: [
      { address, abi: AERODROME_POOL_ABI, functionName: "token0" },
      { address, abi: AERODROME_POOL_ABI, functionName: "token1" },
      { address, abi: AERODROME_POOL_ABI, functionName: "getReserves" },
      { address, abi: UNISWAP_V3_POOL_ABI, functionName: "slot0" },
      { address, abi: UNISWAP_V3_POOL_ABI, functionName: "liquidity" },
      { address, abi: UNISWAP_V3_POOL_ABI, functionName: "fee" },
      { address, abi: AERODROME_POOL_ABI, functionName: "stable" },
      { address, abi: AERODROME_POOL_ABI, functionName: "factory" },
    ],
  });
  if (t0.status !== "success" || t1.status !== "success") return null;
  const isV3 = slot0.status === "success" && liq.status === "success";
  const isV2 = !isV3 && reserves.status === "success";
  if (!isV2 && !isV3) return null;

  const [token0, token1] = await Promise.all([
    readTokenMeta(chainId, getAddress(t0.result)),
    readTokenMeta(chainId, getAddress(t1.result)),
  ]);
  if (!token0 || !token1) return null;

  const factoryAddr = factory.status === "success" ? getAddress(factory.result) : null;
  const block = { chainId, number: blockNumber.toString(), timestamp: Number(latest.timestamp) };

  if (isV3) {
    const sqrtP = slot0.result[0];
    const L = liq.result;
    const { reserve0, reserve1 } = v3VirtualReserves(sqrtP, L);
    const prices = v3PricesScaled18(sqrtP, token0.decimals, token1.decimals);
    const feeBps = fee.status === "success" ? Number(fee.result) / 100 : 30;
    const overnight = opts.overnight === false ? skipped() : await v3Overnight(chainId, address, blockNumber, sqrtP, reserve0);
    return {
      chainId, address, kind: "uniswap-v3", token0, token1, feeBps, stable: false, factory: factoryAddr,
      reserve0: reserve0.toString(), reserve1: reserve1.toString(), reservesAreVirtual: true,
      sqrtPriceX96: sqrtP.toString(), liquidity: L.toString(), tick: Number(slot0.result[1]),
      token1PerToken0: prices.token1PerToken0.toString(), token0PerToken1: prices.token0PerToken1.toString(),
      block, overnight,
    };
  }

  const r = reserves.result as readonly [bigint, bigint, bigint];
  const isStable = stable.status === "success" ? Boolean(stable.result) : false;
  let feeBps = 30;
  if (factoryAddr) {
    try {
      feeBps = Number(await client.readContract({ address: factoryAddr, abi: AERODROME_FACTORY_ABI, functionName: "getFee", args: [address, isStable] }));
    } catch {
      /* non-Aerodrome v2 fork: keep 30 bps */
    }
  }
  const prices = v2PricesScaled18(r[0], r[1], token0.decimals, token1.decimals);
  const overnight = opts.overnight === false ? skipped() : await v2Overnight(chainId, address, blockNumber, r[0], r[1], token0.decimals, token1.decimals);
  return {
    chainId, address, kind: "aerodrome-v2", token0, token1, feeBps, stable: isStable, factory: factoryAddr,
    reserve0: r[0].toString(), reserve1: r[1].toString(), reservesAreVirtual: false,
    sqrtPriceX96: null, liquidity: null, tick: null,
    token1PerToken0: prices.token1PerToken0.toString(), token0PerToken1: prices.token0PerToken1.toString(),
    block, overnight,
  };
}

function skipped(): OvernightPoolDelta {
  return { method: "unavailable", hours: OVERNIGHT_HOURS, fromBlock: null, reserve0ChangeBps: null, priceChangeBps: null, swapCount: null, token0Volume: null, note: "Overnight delta not requested." };
}

/** v2: archive read of getReserves() at the block ~8h ago, plus Swap-event flow. */
async function v2Overnight(chainId: ChainId, pool: Address, latest: bigint, r0: bigint, r1: bigint, d0: number, d1: number): Promise<OvernightPoolDelta> {
  const client = getPublicClientForChain(chainId);
  let fromBlock: bigint;
  try {
    fromBlock = await blockHoursAgo(chainId, client, latest, OVERNIGHT_HOURS);
  } catch {
    return { ...skipped(), note: "Could not resolve historical block height." };
  }
  let reserve0ChangeBps: number | null = null;
  let priceChangeBps: number | null = null;
  let method: OvernightPoolDelta["method"] = "unavailable";
  let note = "";
  try {
    const past = await client.readContract({ address: pool, abi: AERODROME_POOL_ABI, functionName: "getReserves", blockNumber: fromBlock });
    const pastP = v2PricesScaled18(past[0], past[1], d0, d1).token0PerToken1;
    const nowP = v2PricesScaled18(r0, r1, d0, d1).token0PerToken1;
    reserve0ChangeBps = bpsChange(past[0], r0);
    priceChangeBps = bpsChange(pastP, nowP);
    method = "historical-state";
    note = `getReserves() at block #${fromBlock} vs latest.`;
  } catch {
    note = "RPC does not serve historical state for this window.";
  }
  let swapCount: number | null = null;
  let token0Volume: string | null = null;
  try {
    const logs = await getLogsClientForChain(chainId).getLogs({
      address: pool,
      event: AERODROME_POOL_ABI.find((x) => x.type === "event" && x.name === "Swap") as Extract<(typeof AERODROME_POOL_ABI)[number], { type: "event"; name: "Swap" }>,
      fromBlock,
      toBlock: latest,
    });
    swapCount = logs.length;
    let vol = 0n;
    for (const l of logs) vol += (l.args.amount0In ?? 0n) + (l.args.amount0Out ?? 0n);
    token0Volume = vol.toString();
  } catch {
    /* logs optional */
  }
  return { method, hours: OVERNIGHT_HOURS, fromBlock: fromBlock.toString(), reserve0ChangeBps, priceChangeBps, swapCount, token0Volume, note };
}

/**
 * v3: try archive slot0 first; Robinhood Chain's public RPC prunes state after ~10k blocks,
 * so fall back to Swap/Mint/Burn event logs (which ARE retained) over the window.
 */
async function v3Overnight(chainId: ChainId, pool: Address, latest: bigint, sqrtNow: bigint, virtualR0Now: bigint): Promise<OvernightPoolDelta> {
  const client = getPublicClientForChain(chainId);
  let fromBlock: bigint;
  try {
    fromBlock = await blockHoursAgo(chainId, client, latest, OVERNIGHT_HOURS);
  } catch {
    return { ...skipped(), note: "Could not resolve historical block height." };
  }
  const priceOf = (s: bigint) => (s === 0n ? 0n : (1n << 192n) * 10n ** 18n / (s * s)); // token0 per token1 (raw-units ratio, scaled)
  try {
    const [pastSlot0, pastL] = await Promise.all([
      client.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: "slot0", blockNumber: fromBlock }),
      client.readContract({ address: pool, abi: UNISWAP_V3_POOL_ABI, functionName: "liquidity", blockNumber: fromBlock }),
    ]);
    const pastR0 = v3VirtualReserves(pastSlot0[0], pastL).reserve0;
    return {
      method: "historical-state", hours: OVERNIGHT_HOURS, fromBlock: fromBlock.toString(),
      reserve0ChangeBps: bpsChange(pastR0, virtualR0Now), priceChangeBps: bpsChange(priceOf(pastSlot0[0]), priceOf(sqrtNow)),
      swapCount: null, token0Volume: null, note: `slot0()/liquidity() at block #${fromBlock} vs latest.`,
    };
  } catch {
    /* fall through to logs */
  }
  try {
    // Robinhood's RPC caps OR'd multi-topic queries at 100k blocks but serves unfiltered address
    // queries over the full window — so fetch raw logs and decode Swap/Mint/Burn locally.
    const raw = await getLogsClientForChain(chainId).getLogs({ address: pool, fromBlock, toBlock: latest });
    const logs = parseEventLogs({ abi: UNISWAP_V3_POOL_ABI, logs: raw, strict: false });
    let swaps = 0;
    let vol0 = 0n;
    let firstSqrt: bigint | null = null;
    let minted0 = 0n;
    let burned0 = 0n;
    for (const l of logs) {
      if (l.eventName === "Swap") {
        swaps++;
        const a0 = l.args.amount0 ?? 0n;
        vol0 += a0 < 0n ? -a0 : a0;
        if (firstSqrt === null && l.args.sqrtPriceX96) firstSqrt = l.args.sqrtPriceX96;
      } else if (l.eventName === "Mint") {
        minted0 += l.args.amount0 ?? 0n;
      } else if (l.eventName === "Burn") {
        burned0 += l.args.amount0 ?? 0n;
      }
    }
    const netLp0 = minted0 - burned0;
    const reserve0ChangeBps = virtualR0Now > 0n && (minted0 > 0n || burned0 > 0n) ? Number((netLp0 * 10_000n) / virtualR0Now) : 0;
    return {
      method: "event-logs", hours: OVERNIGHT_HOURS, fromBlock: fromBlock.toString(),
      reserve0ChangeBps,
      priceChangeBps: firstSqrt ? bpsChange(priceOf(firstSqrt), priceOf(sqrtNow)) : 0,
      swapCount: swaps, token0Volume: vol0.toString(),
      note: swaps === 0
        ? `0 swaps since block #${fromBlock} — price static overnight (public RPC prunes state; derived from event logs).`
        : `${swaps} swaps since block #${fromBlock}; price Δ measured from first overnight swap (public RPC prunes state; derived from event logs).`,
    };
  } catch {
    return { ...skipped(), fromBlock: fromBlock.toString(), note: "Historical state pruned and event logs unavailable on public RPC." };
  }
}

/**
 * Discover the deepest WETH pool for a token live:
 *  - Base: Aerodrome PoolFactory.getPool(token, WETH, false)
 *  - Robinhood Chain: Uniswap v3 factory (read from the verified VIBES pool's factory()) across fee tiers
 */
export async function discoverWethPool(chainId: ChainId, token: Address): Promise<Address | null> {
  const client = getPublicClientForChain(chainId);
  const lower = token.toLowerCase();
  if (chainId === 8453) {
    if (lower === CONTRACTS.base.vibesToken.toLowerCase()) return CONTRACTS.base.vibesAerodromePool;
    if (lower === CONTRACTS.base.weth.toLowerCase()) return null;
    try {
      const p = await client.readContract({ address: CONTRACTS.base.aerodromeFactory, abi: AERODROME_FACTORY_ABI, functionName: "getPool", args: [token, CONTRACTS.base.weth, false] });
      return p && p !== ZERO ? getAddress(p) : null;
    } catch {
      return null;
    }
  }
  if (lower === CONTRACTS.robinhood.vibesToken.toLowerCase()) return CONTRACTS.robinhood.vibesUniswapV3Pool;
  if (lower === CONTRACTS.robinhood.weth.toLowerCase()) return null;
  try {
    const v3Factory = await client.readContract({ address: CONTRACTS.robinhood.vibesUniswapV3Pool, abi: UNISWAP_V3_POOL_ABI, functionName: "factory" });
    const tiers = [10000, 3000, 500] as const;
    const res = await client.multicall({
      allowFailure: true,
      contracts: tiers.map((fee) => ({ address: v3Factory, abi: UNISWAP_V3_FACTORY_ABI, functionName: "getPool" as const, args: [token, CONTRACTS.robinhood.weth, fee] as const })),
    });
    const found = res.map((r) => (r.status === "success" ? r.result : ZERO)).filter((a) => a !== ZERO);
    return found[0] ? getAddress(found[0]) : null;
  } catch {
    return null;
  }
}
