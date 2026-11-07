import { CONTRACTS } from "@/config/contracts";
import { ETH_USD_REFERENCE } from "@/config/price-feeds";
import { ERC20_ABI, UNISWAP_V3_POOL_ABI } from "@/lib/abis";
import { bpsOf, creditWaitSeconds, type CpLeg, optimalRoundTrip, roundTrip } from "@/lib/bridge-math";
import { basePublicClient, robinhoodPublicClient } from "@/lib/rpc";
import { readOftBridge } from "./oft";
import { readPool } from "./pools";
import type { ArbRoundTripView, EthUsdQuote, OftBridgeReport, OftLane, ParityReport, ParityVerdict, PoolSnapshot } from "./types";

/** Typical gas for a single-hop AMM swap; used only to express gas drag in ETH terms. */
const SWAP_GAS_UNITS = 150_000;
/** Direct VibesOFTAdapter.send() gasUsed measured on real txs (Base 267,507 / 274,325; Robinhood 267,500) — verified 2026-11-07. */
const OFT_SEND_GAS_UNITS = 270_000;
/** Reference notional for the headline net edge: 0.1 WETH. */
export const ARB_REFERENCE_WEI = 10n ** 17n;
const Q192 = 1n << 192n;

function vibesPerWeth(pool: PoolSnapshot | null, vibes: string): bigint {
  if (!pool) return 0n;
  // token1PerToken0 = VIBES per WETH when token0 is WETH
  return pool.token0.address.toLowerCase() === vibes.toLowerCase() ? BigInt(pool.token0PerToken1) : BigInt(pool.token1PerToken0);
}

/** WETH→VIBES (buy) or VIBES→WETH (sell) constant-product leg on a pool snapshot (v3 uses active-range virtual reserves). */
function leg(pool: PoolSnapshot, vibes: string, dir: "buy" | "sell"): CpLeg {
  const vibesIs0 = pool.token0.address.toLowerCase() === vibes.toLowerCase();
  const rV = BigInt(vibesIs0 ? pool.reserve0 : pool.reserve1);
  const rW = BigInt(vibesIs0 ? pool.reserve1 : pool.reserve0);
  return dir === "buy" ? { reserveIn: rW, reserveOut: rV, feeBps: pool.feeBps } : { reserveIn: rV, reserveOut: rW, feeBps: pool.feeBps };
}

/** Live ETH/USD from Uniswap v3 WETH/USDC slot0 on Base, pinned to the parity read's Base block. */
async function readEthUsd(blockNumber: bigint): Promise<EthUsdQuote | null> {
  try {
    const [sqrtPriceX96] = await basePublicClient.readContract({ address: ETH_USD_REFERENCE.pool, abi: UNISWAP_V3_POOL_ABI, functionName: "slot0", blockNumber });
    if (sqrtPriceX96 === 0n) return null;
    // token0 = WETH (18), token1 = USDC (6): raw USDC per raw wei = sqrtP² / 2¹⁹² → per 1 WETH multiply by 1e18
    const usdcPerWeth = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192;
    return { usdcPerWeth: usdcPerWeth.toString(), pool: ETH_USD_REFERENCE.pool, chainId: 8453, block: blockNumber.toString(), source: ETH_USD_REFERENCE.label };
  } catch {
    return null;
  }
}

async function readBacking(baseBlockNumber: bigint, rhBlockNumber: bigint) {
  const [locked, rhSupply, rhReserve] = await Promise.all([
    basePublicClient.readContract({ address: CONTRACTS.base.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.base.vibesBridgeAdapter], blockNumber: baseBlockNumber }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "totalSupply", blockNumber: rhBlockNumber }),
    robinhoodPublicClient.readContract({ address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.robinhood.vibesReserveAdapter], blockNumber: rhBlockNumber }),
  ]);
  return { locked, rhSupply, rhReserve };
}

/** Packets in flight across both lanes; null when the bridge or any lane's nonces could not be read (UNKNOWN, never 0). */
function pendingOf(bridge: OftBridgeReport | null): number | null {
  if (!bridge || bridge.lanes.some((l) => l.nonces.known === false)) return null;
  return bridge.lanes.reduce((n, l) => n + l.nonces.unverified + l.nonces.awaitingExecution.length, 0);
}

function verdictOf(deltaSigned: bigint, pending: number | null): ParityVerdict {
  // In-flight/stuck packets always make locked > circulating (lock / reserve-return happens at send, release at receive),
  // so only circulating > locked is a real backing failure. With unreadable nonces a positive Δ cannot be called
  // OVER_BACKED ("no packet in flight" is unknown): report the IN_FLIGHT candidate with pendingPackets = null.
  return deltaSigned === 0n ? "EXACT" : deltaSigned < 0n ? "UNBACKED" : pending === null || pending > 0 ? "IN_FLIGHT" : "OVER_BACKED";
}

function bridgeDegradedOf(bridge: OftBridgeReport | null): string | undefined {
  if (!bridge) return "OFT bridge read failed: LayerZero nonces, peers and the in-flight count are UNKNOWN";
  const bad = bridge.lanes.filter((l) => l.peersOk === null || l.nonces.known === false);
  return bad.length ? `OFT ${bad.map((l) => l.direction).join(" + ")} lane read incomplete (peers/nonces UNKNOWN)` : undefined;
}

/**
 * Live dual-RPC $VIBES LayerZero OFT parity + cross-venue spread, net of the REAL LayerZero fee (quoteSend),
 * gas, trade-size price impact and the destination credit budget (rate limit).
 * Invariant: BaseAdapter.balanceOf == RH.totalSupply − RHReserveAdapter.balanceOf
 */
export async function getBridgeParity(opts: { overnight?: boolean; notionalWei?: bigint } = {}): Promise<ParityReport> {
  let [baseBlock, rhBlock] = await Promise.all([
    basePublicClient.getBlock({ blockTag: "latest" }),
    robinhoodPublicClient.getBlock({ blockTag: "latest" }),
  ]);
  const [backing, basePool, rhPool, baseGas, rhGas, bridge, ethUsd] = await Promise.all([
    readBacking(baseBlock.number, rhBlock.number),
    readPool(8453, CONTRACTS.base.vibesAerodromePool, opts).catch(() => null),
    readPool(4663, CONTRACTS.robinhood.vibesUniswapV3Pool, opts).catch(() => null),
    basePublicClient.getGasPrice().catch(() => 0n),
    robinhoodPublicClient.getGasPrice().catch(() => 0n),
    readOftBridge({ blocks: { base: baseBlock, robinhood: rhBlock } }).catch(() => null as OftBridgeReport | null),
    readEthUsd(baseBlock.number),
  ]);
  let { locked, rhSupply, rhReserve } = backing;
  let finalBridge = bridge;

  let circulating = rhSupply - rhReserve;
  let deltaSigned = locked - circulating;
  let verdict = verdictOf(deltaSigned, pendingOf(finalBridge));
  if (verdict === "UNBACKED") {
    // Never flag unbacked supply on a single pair of reads: re-read both chains at fresh blocks first (guards RPC lag / skew).
    const [b2, r2] = await Promise.all([basePublicClient.getBlock({ blockTag: "latest" }), robinhoodPublicClient.getBlock({ blockTag: "latest" })]);
    const [again, bridge2] = await Promise.all([readBacking(b2.number, r2.number), readOftBridge({ blocks: { base: b2, robinhood: r2 } }).catch(() => null as OftBridgeReport | null)]);
    ({ locked, rhSupply, rhReserve } = again);
    baseBlock = b2;
    rhBlock = r2;
    finalBridge = bridge2 ?? finalBridge;
    circulating = rhSupply - rhReserve;
    deltaSigned = locked - circulating;
    verdict = verdictOf(deltaSigned, pendingOf(finalBridge));
  }
  const delta = deltaSigned >= 0n ? deltaSigned : -deltaSigned;

  const baseP = vibesPerWeth(basePool, CONTRACTS.base.vibesToken);
  const rhP = vibesPerWeth(rhPool, CONTRACTS.robinhood.vibesToken);
  const spreadBps = baseP > 0n && rhP > 0n ? Number(((rhP - baseP) * 10_000n) / baseP) : null;
  // more VIBES per WETH => VIBES is cheaper on that venue
  const cheaperVenue: ParityReport["cheaperVenue"] = spreadBps === null || spreadBps === 0 ? null : spreadBps > 0 ? "robinhood" : "base";
  const feeDragBps = basePool && rhPool ? basePool.feeBps + rhPool.feeBps : null;
  const netEdgeBpsBeforeBridge = spreadBps !== null && feeDragBps !== null ? Math.abs(spreadBps) - feeDragBps : null;

  // ---- Fee-, gas- and rate-limit-aware round trip (cheap venue → bridge → rich venue)
  const notional = opts.notionalWei && opts.notionalWei > 0n ? opts.notionalWei : ARB_REFERENCE_WEI;
  const buyOnRh = cheaperVenue === "robinhood";
  const lane: OftLane | null = finalBridge?.lanes.find((l) => l.direction === (buyOnRh ? "robinhood->base" : "base->robinhood")) ?? null;
  const lzFeeWei = lane && BigInt(lane.nativeFeeWei) > 0n ? BigInt(lane.nativeFeeWei) : null;
  const srcGas = buyOnRh ? rhGas : baseGas;
  const dstGas = buyOnRh ? baseGas : rhGas;
  const gasWei = srcGas > 0n && dstGas > 0n ? srcGas * BigInt(SWAP_GAS_UNITS + OFT_SEND_GAS_UNITS) + dstGas * BigInt(SWAP_GAS_UNITS) : null;
  const bridgeFeeBps = lzFeeWei !== null ? bpsOf(lzFeeWei, notional) : null;
  const gasBps = gasWei !== null ? bpsOf(gasWei, notional) : null;

  let arb: ArbRoundTripView | null = null;
  if (cheaperVenue && basePool && rhPool && finalBridge && lane && lzFeeWei !== null && gasWei !== null) {
    const buy = buyOnRh ? leg(rhPool, CONTRACTS.robinhood.vibesToken, "buy") : leg(basePool, CONTRACTS.base.vibesToken, "buy");
    const sell = buyOnRh ? leg(basePool, CONTRACTS.base.vibesToken, "sell") : leg(rhPool, CONTRACTS.robinhood.vibesToken, "sell");
    const dust = BigInt(finalBridge.dustUnit);
    const fixed = lzFeeWei + gasWei;
    const ref = roundTrip(notional, buy, sell, dust, fixed);
    const best = optimalRoundTrip(buy, sell, dust, fixed, buy.reserveIn / 2n);
    const sized = best ?? ref;
    const wait = lane.credit ? creditWaitSeconds(sized.vibesBridged, BigInt(lane.credit.inFlight), BigInt(lane.credit.limit), BigInt(lane.credit.windowSec)) : null;
    arb = {
      direction: lane.direction,
      lzFeeWei: lzFeeWei.toString(),
      gasWei: gasWei.toString(),
      reference: {
        wethIn: ref.wethIn.toString(),
        wethOut: ref.wethOut.toString(),
        vibesBridged: ref.vibesBridged.toString(),
        profitWei: ref.profitWei.toString(),
        netEdgeBps: bpsOf(ref.profitWei, ref.wethIn),
        lzFeeBps: bridgeFeeBps,
        gasBps,
      },
      optimal: best
        ? { wethIn: best.wethIn.toString(), wethOut: best.wethOut.toString(), vibesBridged: best.vibesBridged.toString(), profitWei: best.profitWei.toString(), netEdgeBps: bpsOf(best.profitWei, best.wethIn) }
        : null,
      creditWaitSec: wait === null ? null : Number(wait),
      model:
        "Exact BigInt x·y=k on live reserves (Uniswap v3 leg: active-range virtual reserves, no tick crossings) · live LayerZero quoteSend() fee (enforced 150k lzReceive gas, minimum) · live L2 gas price × (150k swap + 270k OFT send + 150k swap; L1 data fee excluded) · OFT dust truncation · destination credit budget. Assumes pre-funded WETH on both chains (no ETH rebalancing leg).",
    };
  }
  const netEdgeBps =
    netEdgeBpsBeforeBridge !== null && bridgeFeeBps !== null && gasBps !== null ? netEdgeBpsBeforeBridge - bridgeFeeBps - gasBps : null;

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
    deltaSigned: deltaSigned.toString(),
    verified: delta === 0n,
    verdict,
    pendingPackets: pendingOf(finalBridge),
    ...(bridgeDegradedOf(finalBridge) ? { bridgeDegraded: bridgeDegradedOf(finalBridge) } : {}),
    basePool,
    rhPool,
    baseVibesPerWeth: baseP.toString(),
    rhVibesPerWeth: rhP.toString(),
    spreadBps,
    cheaperVenue,
    feeDragBps,
    netEdgeBpsBeforeBridge,
    bridgeFeeBps,
    gasBps,
    arbNotionalWei: notional.toString(),
    netEdgeBps,
    gas: {
      baseGwei: gwei(baseGas),
      rhGwei: gwei(rhGas),
      swapGasUnits: SWAP_GAS_UNITS,
      baseSwapCostWei: (baseGas * BigInt(SWAP_GAS_UNITS)).toString(),
      rhSwapCostWei: (rhGas * BigInt(SWAP_GAS_UNITS)).toString(),
    },
    bridge: finalBridge,
    arb,
    ethUsd,
    fetchedAt: new Date().toISOString(),
  };
}
