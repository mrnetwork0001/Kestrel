"use client";

import { CONTRACTS } from "@/config/contracts";
import { AddrLink, ChainBadge, Panel, Stat } from "@/components/ui";
import { chainShort, explorerBlock, fmtBps, fmtCompact, fmtDuration, fmtUnits } from "@/lib/format";
import { BridgeLaneXray, ethWithUsd, VERDICT_TEXT, VerdictBadge } from "./bridge-ui";
import { useParity } from "./use-api";

function bpsCell(v: number | null | undefined, negate = false) {
  if (v === null || v === undefined) return "unavailable";
  if (v === 0 && negate) return "<1 bps"; // bps are floored: a real but sub-bps cost
  return `${negate ? "−" : ""}${v} bps`;
}

export function ParityTab() {
  const { data: p, error, isFetching, dataUpdatedAt } = useParity();
  if (error && !p) return <Panel><p className="mono text-[13px] text-crit">Parity read failed: {error.message}</p></Panel>;
  if (!p) return <Panel><p className="mono text-[13px] text-ink-3 cursor-blink">Reading both chains</p></Panel>;

  const spreadAbs = p.spreadBps != null ? Math.abs(p.spreadBps) : 0;
  const verdict = p.verdict ?? (p.verified ? "EXACT" : "IN_FLIGHT");
  const arbLane = p.arb ? p.bridge?.lanes.find((l) => l.direction === p.arb!.direction) ?? null : null;
  const notional = p.arbNotionalWei ?? "100000000000000000";
  const notionalLabel = `${fmtUnits(notional, 18, 4)} Ξ`;
  return (
    <div className="space-y-6 max-[600px]:space-y-4">
      <Panel
        title="$VIBES LayerZero OFT · 1:1 proof of reserve"
        n="01"
        right={<span className="mono text-[10px] text-ink-3">{isFetching ? "refreshing…" : `auto-refresh 30s · ${new Date(dataUpdatedAt).toISOString().slice(11, 19)} UTC`}</span>}
      >
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] max-[600px]:gap-4">
          <div className="min-w-0 border hairline p-4 max-[600px]:p-3">
            <div className="flex items-center justify-between"><ChainBadge chainId={8453} /><a href={explorerBlock(8453, p.base.number)} target="_blank" rel="noreferrer" className="mono text-[10px] text-ink-3 hover:text-ink max-[900px]:py-2.5">#{BigInt(p.base.number).toLocaleString("en-US")} ↗</a></div>
            <Stat className="mt-4" label="Locked in Base OFT adapter" value={fmtUnits(p.lockedOnBase, 18, 6)} tone="base" sub="VIBES.balanceOf(BaseAdapter)" />
            <AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} className="mt-2 inline-block text-[11px]" />
          </div>
          <div className="text-center">
            <p className={`tnum text-[28px] ${verdict === "EXACT" ? "text-phosphor" : verdict === "UNBACKED" ? "text-crit" : "text-ink-2"}`}>{verdict === "EXACT" ? "==" : verdict === "UNBACKED" ? "<" : ">"}</p>
            <VerdictBadge verdict={verdict} />
            <p className="mt-2 mono text-[10px] text-ink-3">
              Δ {BigInt(p.deltaSigned ?? p.delta) < 0n ? "−" : ""}
              {fmtUnits(p.delta, 18, 6)}
              {verdict === "IN_FLIGHT" ? ` · ${p.pendingPackets} packet${p.pendingPackets === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <div className="min-w-0 border hairline p-4 max-[600px]:p-3">
            <div className="flex items-center justify-between"><ChainBadge chainId={4663} /><a href={explorerBlock(4663, p.robinhood.number)} target="_blank" rel="noreferrer" className="mono text-[10px] text-ink-3 hover:text-ink max-[900px]:py-2.5">#{BigInt(p.robinhood.number).toLocaleString("en-US")} ↗</a></div>
            <Stat className="mt-4" label="Circulating on Robinhood Chain" value={fmtUnits(p.rhCirculating, 18, 6)} tone="rh" sub="totalSupply() − balanceOf(ReserveAdapter)" />
            <p className="mt-2 mono text-[11px] text-ink-3">
              supply {fmtCompact(p.rhTotalSupply, 18)} − reserve {fmtCompact(p.rhReserve, 18)} · <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} label="adapter" />
            </p>
          </div>
        </div>
        <p className="mt-4 text-[12px] text-ink-3">
          <span className="text-ink-2">{VERDICT_TEXT[verdict]}</span> The bridge locks at send and releases at delivery, so a packet in flight can only make locked exceed circulating. Kestrel reads both endpoints&apos; nonces at the same blocks to tell IN FLIGHT from OVER BACKED, and only flags UNBACKED after a second pair of fresh reads agrees.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2 max-[600px]:gap-4">
        <Panel title="Cross-venue dislocation" n="02">
          <div className="grid grid-cols-2 gap-6 max-[600px]:gap-4">
            <Stat label="Base Aerodrome · VIBES per WETH" value={fmtCompact(p.baseVibesPerWeth, 18)} tone="base" sub={p.basePool ? <AddrLink chainId={8453} address={p.basePool.address} /> : "unavailable"} />
            <Stat label="RH Uniswap v3 · VIBES per WETH" value={fmtCompact(p.rhVibesPerWeth, 18)} tone="rh" sub={p.rhPool ? <AddrLink chainId={4663} address={p.rhPool.address} /> : "unavailable"} />
          </div>
          <div className="mt-6 border-t hairline pt-4">
            <div className="flex items-end gap-4 max-[600px]:flex-wrap max-[600px]:gap-y-1">
              <Stat label="Spread" value={p.spreadBps != null ? fmtBps(p.spreadBps) : "—"} tone={spreadAbs >= 300 ? "warn" : undefined} />
              <p className="mb-1 text-[12px] text-ink-3">{p.cheaperVenue ? `VIBES trades cheaper on ${p.cheaperVenue === "base" ? "Base" : "Robinhood Chain"}.` : "Venues aligned."}</p>
            </div>
            <div className="relative mt-4 h-1.5 bg-white/[0.06]">
              <div className="absolute inset-y-[-4px] left-1/2 w-px bg-white/30" />
              <div className={`absolute inset-y-0 ${(p.spreadBps ?? 0) >= 0 ? "left-1/2 bg-rh" : "right-1/2 bg-base"}`} style={{ width: `${Math.min(50, spreadAbs / 10)}%` }} />
            </div>
            <div className="mt-1 flex justify-between mono text-[10px] text-ink-3"><span>cheaper on Base</span><span>0</span><span>cheaper on RH</span></div>
          </div>
        </Panel>

        <Panel title="Arbitrage reality check" n="03">
          <dl className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-x-3 gap-y-2 mono text-[12px] sm:grid-cols-[minmax(0,1fr)_auto] [&_dd]:break-words">
            <dt className="text-ink-3">Gross spread</dt><dd className="text-right text-ink">{p.spreadBps != null ? `${spreadAbs} bps` : "unavailable"}</dd>
            <dt className="text-ink-3">Pool fees (both legs)</dt><dd className="text-right text-ink">{bpsCell(p.feeDragBps, true)}</dd>
            <dt className="text-ink-3">Net edge before gas &amp; bridge</dt><dd className="text-right text-ink-2">{bpsCell(p.netEdgeBpsBeforeBridge)}</dd>
            <dt className="text-ink-3">
              LayerZero fee @ {notionalLabel}
              {p.arb && <span className="block text-[10px]">{ethWithUsd(p.arb.lzFeeWei, p.ethUsd, 7)} · {p.arb.direction === "robinhood->base" ? "RH → Base" : "Base → RH"} quoteSend()</span>}
            </dt>
            <dd className="text-right text-ink">{bpsCell(p.bridgeFeeBps, true)}</dd>
            <dt className="text-ink-3">
              Gas (swap + OFT send + swap)
              {p.arb && <span className="block text-[10px]">{ethWithUsd(p.arb.gasWei, p.ethUsd, 7)} · Base {p.gas.baseGwei} / RH {p.gas.rhGwei} gwei</span>}
            </dt>
            <dd className="text-right text-ink">{bpsCell(p.gasBps, true)}</dd>
            <dt className="border-t hairline pt-2 text-ink-2">Net edge (marginal, all costs)</dt>
            <dd className={`border-t hairline pt-2 text-right ${p.netEdgeBps != null && p.netEdgeBps > 0 ? "text-phosphor" : p.netEdgeBps != null ? "text-warn" : "text-ink-3"}`}>{bpsCell(p.netEdgeBps)}</dd>
            <dt className="text-ink-3">
              Exact round trip @ {notionalLabel}
              <span className="block text-[10px]">buy · bridge · sell, incl. price impact</span>
            </dt>
            <dd className={`text-right ${p.arb && Number(p.arb.reference.netEdgeBps ?? 0) > 0 ? "text-phosphor" : "text-ink-2"}`}>
              {p.arb ? (
                <>
                  {bpsCell(p.arb.reference.netEdgeBps)}
                  <span className="block text-[10px] text-ink-3">{ethWithUsd(p.arb.reference.profitWei, p.ethUsd, 6)}</span>
                </>
              ) : (
                "unavailable"
              )}
            </dd>
            <dt className="text-ink-3">Best size</dt>
            <dd className="text-right text-ink-2">
              {p.arb ? (p.arb.optimal ? `${fmtUnits(p.arb.optimal.wethIn, 18, 4)} Ξ → ${ethWithUsd(p.arb.optimal.profitWei, p.ethUsd, 6)}` : "none profitable") : "unavailable"}
            </dd>
            <dt className="text-ink-3">Bridge headroom ({arbLane ? chainShort(arbLane.dstChainId) : "dest"})</dt>
            <dd className="text-right text-ink-2">
              {arbLane?.credit ? `${fmtCompact(arbLane.credit.headroom, 18)} / ${fmtCompact(arbLane.credit.limit, 18)} per ${fmtDuration(arbLane.credit.windowSec)}` : "unavailable"}
              {p.arb && p.arb.creditWaitSec !== null && p.arb.creditWaitSec > 0 && <span className="block text-[10px] text-warn">arb size waits {fmtDuration(p.arb.creditWaitSec)}</span>}
            </dd>
          </dl>
          <p className="mt-4 text-[12px] text-ink-3">
            {p.netEdgeBps == null
              ? "The live LayerZero fee could not be read this refresh, so no all-in net edge is shown."
              : p.netEdgeBps > 0
                ? "The spread beats pool fees, the LayerZero fee and gas at the margin. Price impact at real size decides it: see the exact round trip."
                : "After pool fees, the live LayerZero fee and gas there is no arbitrage at the margin."}{" "}
            {p.arb && !p.arb.optimal && "No trade size is profitable on live reserves."} Gas uses live L2 gas prices; the L1 data fee is excluded. The Robinhood v3 leg uses active-range liquidity only.
          </p>
        </Panel>
      </div>

      <BridgeLaneXray p={p} n="04" />
    </div>
  );
}
