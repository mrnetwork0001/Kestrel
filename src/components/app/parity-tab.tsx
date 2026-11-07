"use client";

import { CONTRACTS } from "@/config/contracts";
import { AddrLink, BandBadge, ChainBadge, Panel, Stat } from "@/components/ui";
import { explorerBlock, fmtBps, fmtCompact, fmtUnits } from "@/lib/format";
import { useParity } from "./use-api";

export function ParityTab() {
  const { data: p, error, isFetching, dataUpdatedAt } = useParity();
  if (error && !p) return <Panel><p className="mono text-[13px] text-crit">Parity read failed: {error.message}</p></Panel>;
  if (!p) return <Panel><p className="mono text-[13px] text-ink-3 cursor-blink">Reading both chains</p></Panel>;

  const spreadAbs = p.spreadBps != null ? Math.abs(p.spreadBps) : 0;
  return (
    <div className="space-y-6">
      <Panel
        title="$VIBES LayerZero OFT · 1:1 proof of reserve"
        n="01"
        right={<span className="mono text-[10px] text-ink-3">{isFetching ? "refreshing…" : `auto-refresh 30s · ${new Date(dataUpdatedAt).toISOString().slice(11, 19)} UTC`}</span>}
      >
        <div className="grid items-center gap-6 lg:grid-cols-[1fr_auto_1fr]">
          <div className="border hairline p-4">
            <div className="flex items-center justify-between"><ChainBadge chainId={8453} /><a href={explorerBlock(8453, p.base.number)} target="_blank" rel="noreferrer" className="mono text-[10px] text-ink-3 hover:text-ink">#{BigInt(p.base.number).toLocaleString("en-US")} ↗</a></div>
            <Stat className="mt-4" label="Locked in Base OFT adapter" value={fmtUnits(p.lockedOnBase, 18, 6)} tone="base" sub="VIBES.balanceOf(BaseAdapter)" />
            <AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} className="mt-2 inline-block text-[11px]" />
          </div>
          <div className="text-center">
            <p className={`tnum text-[28px] ${p.verified ? "text-phosphor" : "text-warn"}`}>{p.verified ? "==" : "≠"}</p>
            <BandBadge band={p.verified ? "NOMINAL" : "ELEVATED"} />
            <p className="mt-2 mono text-[10px] text-ink-3">Δ {fmtUnits(p.delta, 18, 6)}</p>
          </div>
          <div className="border hairline p-4">
            <div className="flex items-center justify-between"><ChainBadge chainId={4663} /><a href={explorerBlock(4663, p.robinhood.number)} target="_blank" rel="noreferrer" className="mono text-[10px] text-ink-3 hover:text-ink">#{BigInt(p.robinhood.number).toLocaleString("en-US")} ↗</a></div>
            <Stat className="mt-4" label="Circulating on Robinhood Chain" value={fmtUnits(p.rhCirculating, 18, 6)} tone="rh" sub="totalSupply() − balanceOf(ReserveAdapter)" />
            <p className="mt-2 mono text-[11px] text-ink-3">
              supply {fmtCompact(p.rhTotalSupply, 18)} − reserve {fmtCompact(p.rhReserve, 18)} · <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} label="adapter" />
            </p>
          </div>
        </div>
        <p className="mt-4 text-[12px] text-ink-3">
          A non-zero delta can briefly appear while a LayerZero message is in flight between chains. A delta that persists across several blocks means supply on one side is not backed by the other.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Cross-venue dislocation" n="02">
          <div className="grid grid-cols-2 gap-6">
            <Stat label="Base Aerodrome · VIBES per WETH" value={fmtCompact(p.baseVibesPerWeth, 18)} tone="base" sub={p.basePool ? <AddrLink chainId={8453} address={p.basePool.address} /> : "unavailable"} />
            <Stat label="RH Uniswap v3 · VIBES per WETH" value={fmtCompact(p.rhVibesPerWeth, 18)} tone="rh" sub={p.rhPool ? <AddrLink chainId={4663} address={p.rhPool.address} /> : "unavailable"} />
          </div>
          <div className="mt-6 border-t hairline pt-4">
            <div className="flex items-end gap-4">
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
          <dl className="grid grid-cols-[1fr_auto] gap-y-2 mono text-[12px]">
            <dt className="text-ink-3">Gross spread</dt><dd className="text-right text-ink">{p.spreadBps != null ? `${spreadAbs} bps` : "—"}</dd>
            <dt className="text-ink-3">Pool fees (both legs)</dt><dd className="text-right text-ink">−{p.feeDragBps ?? "—"} bps</dd>
            <dt className="text-ink-3">Net edge before gas & bridge</dt>
            <dd className={`text-right ${p.netEdgeBps != null && p.netEdgeBps > 0 ? "text-phosphor" : "text-ink-2"}`}>{p.netEdgeBps != null ? `${p.netEdgeBps} bps` : "—"}</dd>
            <dt className="text-ink-3">Base gas · swap cost</dt><dd className="text-right text-ink-2">{p.gas.baseGwei} gwei · {fmtUnits(p.gas.baseSwapCostWei, 18, 7)} Ξ</dd>
            <dt className="text-ink-3">RH gas · swap cost</dt><dd className="text-right text-ink-2">{p.gas.rhGwei} gwei · {fmtUnits(p.gas.rhSwapCostWei, 18, 7)} Ξ</dd>
          </dl>
          <p className="mt-4 text-[12px] text-ink-3">
            {p.netEdgeBps != null && p.netEdgeBps > 0
              ? "Spread exceeds round-trip pool fees. LayerZero messaging fees and slippage at your size still apply — size it in Simulate the Rug."
              : "Spread is inside round-trip pool fees: no clean arbitrage. Venues are effectively in line."}{" "}
            Gas estimate assumes {p.gas.swapGasUnits.toLocaleString("en-US")} gas per swap at live gas price.
          </p>
        </Panel>
      </div>
    </div>
  );
}
