"use client";

import { Panel, Stat } from "@/components/ui";
import { CONTRACTS } from "@/config/contracts";
import { quoteExactIn } from "@/lib/amm-math";
import { creditWaitSeconds, optimalRoundTrip, removeDust } from "@/lib/bridge-math";
import { chainShort, fmtBps, fmtCompact, fmtDuration, fmtUnits } from "@/lib/format";
import type { OftLane, ParityReport, PoolSnapshot } from "@/lib/engine/types";
import { usdOfWei } from "./bridge-ui";

const OFT_SEND_GAS_UNITS = 270_000n;

/** VIBES-side / WETH-side reserves of a VIBES/WETH pool, picked by token address (never by symbol). */
function sides(p: PoolSnapshot, vibes: string) {
  const vIs0 = p.token0.address.toLowerCase() === vibes.toLowerCase();
  return { rV: BigInt(vIs0 ? p.reserve0 : p.reserve1), rW: BigInt(vIs0 ? p.reserve1 : p.reserve0) };
}

/** True when `pool` is one of the two live $VIBES/WETH venues the parity engine reads (the only pools the bridge can rebalance). */
export function isParityVibesPool(parity: ParityReport | null | undefined, pool: PoolSnapshot | null | undefined): boolean {
  if (!parity || !pool) return false;
  return [parity.basePool, parity.rhPool].some((p) => p && p.chainId === pool.chainId && p.address.toLowerCase() === pool.address.toLowerCase());
}

/** The lane that delivers VIBES INTO `chainId` (its credit budget caps how much new VIBES can arrive per window). */
export function inboundLane(parity: ParityReport | null | undefined, chainId: number): OftLane | null {
  return parity?.bridge?.lanes.find((l) => l.dstChainId === chainId) ?? null;
}

/**
 * "OFT bridge saturated" made real: live LayerZero fee, live credit budget (rate limit) of the lane that carries VIBES
 * OUT of the stressed chain, and the time a cross-chain arbitrage needs to re-peg the shocked pool.
 */
export function BridgeEscapePanel(props: {
  parity: ParityReport;
  selected: PoolSnapshot; // the stressed pool (Base Aerodrome or RH Uniswap v3)
  position: bigint; // user's VIBES (raw)
  postShock: { reserveToken: bigint; reserveWeth: bigint }; // local pool AFTER LP pull + whale dump (from simulateConstantProductShock)
  saturated: boolean; // scenario toggle: in-flight == limit on the outbound lane
  n?: string;
}) {
  const { parity, selected, position, postShock, saturated, n = "04" } = props;
  const bridge = parity.bridge;
  const lane = bridge?.lanes.find((l) => l.srcChainId === selected.chainId) ?? null; // local → other
  const other = selected.chainId === 8453 ? parity.rhPool : parity.basePool;
  if (!bridge || !lane || !lane.credit || !other || BigInt(lane.nativeFeeWei) === 0n) {
    return (
      <Panel title="Bridge escape" n={n}>
        <p className="mono text-[12px] text-warn">Live LayerZero lane data (fee or credit budget) or the other venue&apos;s reserves are unavailable at this refresh, so the bridge escape is not modelled rather than estimated.</p>
      </Panel>
    );
  }

  const ethUsd = parity.ethUsd ?? null;
  const o = sides(other, selected.chainId === 8453 ? CONTRACTS.robinhood.vibesToken : CONTRACTS.base.vibesToken);
  const dust = BigInt(bridge.dustUnit);
  const fee = BigInt(lane.nativeFeeWei);
  const limit = BigInt(lane.credit.limit);
  const windowSec = BigInt(lane.credit.windowSec);
  const inFlight = saturated ? limit : BigInt(lane.credit.inFlight);
  const headroom = saturated ? 0n : BigInt(lane.credit.headroom);
  const halted = lane.srcPaused === true || lane.dstPaused === true;
  const srcSwapGas = BigInt(selected.chainId === 8453 ? parity.gas.baseSwapCostWei : parity.gas.rhSwapCostWei);
  const dstSwapGas = BigInt(selected.chainId === 8453 ? parity.gas.rhSwapCostWei : parity.gas.baseSwapCostWei);
  const sendGas = (srcSwapGas * OFT_SEND_GAS_UNITS) / BigInt(parity.gas.swapGasUnits || 150_000);

  // 1) Escape hatch: bridge the position to the unshocked venue and sell there (LZ fee + send gas + remote swap gas)
  const bridged = removeDust(position, dust);
  const escapeOut = quoteExactIn(bridged, o.rV, o.rW, other.feeBps);
  const escapeCost = fee + sendGas + dstSwapGas;
  const escapeNet = escapeOut > escapeCost ? escapeOut - escapeCost : 0n;
  const escapeWait = creditWaitSeconds(bridged, inFlight, limit, windowSec);
  const tooBig = bridged > limit;
  const localExit = quoteExactIn(position, postShock.reserveToken, postShock.reserveWeth, selected.feeBps);
  const escapeBetter = escapeNet > localExit;

  // 2) Re-peg: profit-maximising arb size on post-shock reserves (buy cheap local → bridge → sell remote)
  const best = optimalRoundTrip(
    { reserveIn: postShock.reserveWeth, reserveOut: postShock.reserveToken, feeBps: selected.feeBps },
    { reserveIn: o.rV, reserveOut: o.rW, feeBps: other.feeBps },
    dust,
    fee + srcSwapGas + sendGas + dstSwapGas,
    postShock.reserveWeth / 2n,
  );
  const repegVibes = best?.vibesBridged ?? 0n;
  const repegWait = creditWaitSeconds(repegVibes, inFlight, limit, windowSec);
  // Dislocation of the shocked local pool vs the other venue (VIBES per WETH; + = VIBES cheaper locally)
  const localPx = postShock.reserveWeth > 0n ? (postShock.reserveToken * 10n ** 18n) / postShock.reserveWeth : 0n;
  const otherPx = o.rW > 0n ? (o.rV * 10n ** 18n) / o.rW : 0n;
  const dislocationBps = otherPx > 0n ? Number(((localPx - otherPx) * 10_000n) / otherPx) : null;

  const eta = (w: bigint | null) => (halted || w === null ? "lane closed" : w === 0n ? "now + LayerZero latency" : `+${fmtDuration(Number(w))}`);
  const usd = (w: bigint) => {
    const u = usdOfWei(w, ethUsd);
    return u ? ` · ${u}` : "";
  };
  return (
    <Panel
      title={`Bridge escape · ${chainShort(lane.srcChainId)} → ${chainShort(lane.dstChainId)}`}
      n={n}
      right={<span className={`mono text-[10px] ${halted ? "text-crit" : saturated ? "text-warn" : "text-ink-3"}`}>{halted ? "BRIDGE PAUSED" : saturated ? "LANE SATURATED (SIMULATED)" : "LIVE HEADROOM"}</span>}
    >
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 max-[601px]:gap-4">
        <Stat
          label="LayerZero fee (1 message)"
          value={`${fmtUnits(fee, 18, 7)} Ξ`}
          sub={`quoteSend()${usd(fee)} · ${lane.confirmations ?? "?"} conf · ${lane.requiredDvns.map((d) => d.name ?? d.address.slice(0, 8)).join(" + ") || "DVNs unreadable"}`}
        />
        <Stat
          label={`Credit headroom on ${chainShort(lane.dstChainId)}`}
          value={`${fmtCompact(headroom, 18)} VIBES`}
          sub={`limit ${fmtCompact(limit, 18)} / ${fmtDuration(lane.credit.windowSec)} · refills ${fmtCompact(lane.credit.refillPerSec, 18)}/s${saturated ? ` · live ${fmtCompact(lane.credit.headroom, 18)}` : ""}`}
          tone={saturated ? "warn" : undefined}
        />
        <Stat
          label={`Escape: bridge + sell on ${chainShort(lane.dstChainId)}`}
          value={`${fmtUnits(escapeNet, 18, 5)} WETH`}
          sub={tooBig ? "exceeds the per-window credit limit as one message: split it" : `ETA ${eta(escapeWait)}${usd(escapeNet)} · ${escapeBetter ? "beats" : "below"} local exit`}
          tone={halted || tooBig ? "crit" : escapeBetter ? "phosphor" : undefined}
        />
        <Stat
          label="Re-peg arb size"
          value={best ? `${fmtCompact(repegVibes, 18)} VIBES` : "none"}
          sub={best ? `dislocation persists ${eta(repegWait)}` : "no profitable arb after LZ fee + gas"}
          tone={saturated && repegWait !== null && repegWait > 0n ? "warn" : undefined}
        />
      </div>
      <p className="mt-4 mono text-[11px] text-ink-3">
        Shocked {chainShort(selected.chainId)} pool vs {chainShort(lane.dstChainId)}: {dislocationBps !== null ? `${fmtBps(dislocationBps)} VIBES per WETH` : "unavailable"} · escape costs LZ fee + OFT send gas + remote swap gas at live gas prices.
      </p>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
        The credit budget is enforced on the destination adapter (creditBudget(srcEid), linear decay over the window). Over budget, the packet is verified but its delivery reverts with RateLimitExceeded and stays retriable at the endpoint. This happened on 2026-09-05: four Base → Robinhood packets were delayed by 4 min to 3.6 h.
      </p>
    </Panel>
  );
}
