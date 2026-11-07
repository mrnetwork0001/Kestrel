"use client";

import type { CSSProperties, ReactNode } from "react";
import { CONTRACTS } from "@/config/contracts";
import { AddrLink, cx, Panel, Stat } from "@/components/ui";
import { Kicker, SkeletonRows } from "@/components/editorial";
import { Settle } from "@/components/motion";
import { ProportionBars } from "@/components/data/proportion-bars";
import { DataList } from "@/components/data/data-list";
import { chainShort, explorerBlock, fmtBps, fmtCompact, fmtDuration, fmtUnits } from "@/lib/format";
import type { ParityReport } from "@/lib/engine/types";
import { BridgeLaneXray, ethWithUsd, VERDICT_TEXT, VerdictBadge } from "./bridge-ui";
import { useParity } from "./use-api";

function bpsCell(v: number | null | undefined, negate = false) {
  if (v === null || v === undefined) return "unavailable";
  if (v === 0 && negate) return "<1 bps"; // bps are floored: a real but sub-bps cost
  return `${negate ? "−" : ""}${v} bps`;
}

function BlockLink({ chainId, n }: { chainId: number; n: string }) {
  return (
    <a href={explorerBlock(chainId, n)} target="_blank" rel="noreferrer" className="mono text-[12px] text-ink-2 underline decoration-white/15 underline-offset-2 hover:text-ink max-[901px]:inline-block max-[901px]:py-2.5">
      #{BigInt(n).toLocaleString("en-US")} ↗
    </a>
  );
}

/** Base vs Robinhood comparison, as a ruled table (paper). */
function ComparisonTable({ p }: { p: ParityReport }) {
  const rows: { k: string; base: ReactNode; rh: ReactNode }[] = [
    { k: "Token", base: <AddrLink chainId={8453} address={CONTRACTS.base.vibesToken} label="VIBES" />, rh: <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesToken} label="VIBES" /> },
    {
      k: "OFT adapter",
      base: <AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} label="Bridge adapter" />,
      rh: <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} label="Reserve adapter" />,
    },
    {
      k: "Balance / supply",
      base: (
        <>
          {fmtUnits(p.lockedOnBase, 18, 2)}
          <span className="block font-sans text-[12px] text-ink-meta">locked · balanceOf(adapter)</span>
        </>
      ),
      rh: (
        <>
          {fmtUnits(p.rhCirculating, 18, 2)}
          <span className="block font-sans text-[12px] text-ink-meta">
            circulating · {fmtCompact(p.rhTotalSupply, 18)} supply − {fmtCompact(p.rhReserve, 18)} reserve
          </span>
        </>
      ),
    },
    {
      k: "Pool",
      base: p.basePool ? <AddrLink chainId={8453} address={p.basePool.address} label="Aerodrome WETH/VIBES" /> : "—",
      rh: p.rhPool ? <AddrLink chainId={4663} address={p.rhPool.address} label="Uniswap v3 WETH/VIBES" /> : "—",
    },
    { k: "Spot VIBES / WETH", base: p.basePool ? fmtCompact(p.baseVibesPerWeth, 18) : "—", rh: p.rhPool ? fmtCompact(p.rhVibesPerWeth, 18) : "—" },
    { k: "Fee tier", base: p.basePool ? `${(p.basePool.feeBps / 100).toFixed(2)}%` : "—", rh: p.rhPool ? `${(p.rhPool.feeBps / 100).toFixed(2)}%` : "—" },
    { k: "Read at block", base: <BlockLink chainId={8453} n={p.base.number} />, rh: <BlockLink chainId={4663} n={p.robinhood.number} /> },
  ];
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-left">
        <thead>
          <tr className="border-b border-hair-strong">
            <th className="w-[26%] py-2.5 pr-4 font-normal" />
            <th className="py-2.5 pr-4 t-kicker font-normal !text-[color:var(--chain-base)]">Base 8453</th>
            <th className="py-2.5 t-kicker font-normal !text-[color:var(--chain-robinhood)]">Robinhood 4663</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {rows.map((r, i) => (
            <tr key={r.k} {...{ "data-rv": "up" }} style={{ "--i": i } as CSSProperties} className="align-baseline">
              <th scope="row" className="py-3 pr-4 text-[13px] font-normal text-ink-2">{r.k}</th>
              <td className="py-3 pr-4 mono tnum text-[14px] text-ink">{r.base}</td>
              <td className="py-3 mono tnum text-[14px] text-ink">{r.rh}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ParityTab() {
  const { data: p, error, isFetching, dataUpdatedAt } = useParity();
  if (error && !p)
    return (
      <div className="border-t border-hair-strong pt-4">
        <p className="mono text-[13px] text-crit [overflow-wrap:anywhere]">Parity read failed: {error.message}</p>
      </div>
    );
  if (!p) return <SkeletonRows rows={5} caption="Reading Base & Robinhood Chain" />;

  const spreadAbs = p.spreadBps != null ? Math.abs(p.spreadBps) : 0;
  const verdict = p.verdict ?? (p.verified ? "EXACT" : "IN_FLIGHT");
  const arbLane = p.arb ? p.bridge?.lanes.find((l) => l.direction === p.arb!.direction) ?? null : null;
  const notional = p.arbNotionalWei ?? "100000000000000000";
  const notionalLabel = `${fmtUnits(notional, 18, 4)} ETH`;
  const zero = BigInt(p.delta) === 0n;
  const negative = BigInt(p.deltaSigned ?? p.delta) < 0n;
  const deltaTone = verdict === "UNBACKED" ? "text-crit" : p.verified ? "text-phosphor" : "text-warn";
  const deltaStr = zero ? "Δ 0" : `Δ ${negative ? "−" : ""}${fmtCompact(p.delta, 18)}`;
  return (
    <div className="space-y-10 max-[601px]:space-y-8">
      {/* LEAD: Δ, headline, proportion bars */}
      <section className="border-t border-hair-strong pt-4" aria-label="$VIBES 1:1 proof of reserve">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <Kicker tone={verdict === "UNBACKED" ? "crit" : p.verified ? "phosphor" : "warn"}>$VIBES LayerZero OFT · 1:1 proof of reserve</Kicker>
          <span className="mono text-[12px] text-ink-meta">{isFetching ? "refreshing…" : `auto-refresh 30s · ${new Date(dataUpdatedAt).toISOString().slice(11, 19)} UTC`}</span>
        </div>
        <div className="mt-6 grid grid-cols-12 items-end gap-x-8 gap-y-6 max-[901px]:gap-x-4">
          <div className="col-span-12 min-w-0 lg:col-span-7">
            <Settle key={deltaStr} value={deltaStr} className={cx("t-data-xl block", deltaTone)} />
            <h2 className="mt-4 font-serif text-[40px] leading-[1.05] tracking-[-0.01em] text-ink max-[601px]:text-[32px]">
              {zero ? (
                "Not one wei apart."
              ) : (
                <>
                  <span className={deltaTone}>{fmtUnits(p.delta, 18)}</span> VIBES apart.
                </>
              )}
            </h2>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <VerdictBadge verdict={verdict} />
              {verdict === "IN_FLIGHT" && p.pendingPackets != null && (
                <span className="mono text-[12px] text-ink-2">
                  {p.pendingPackets} packet{p.pendingPackets === 1 ? "" : "s"} in flight
                </span>
              )}
              {p.bridgeDegraded && <span className="mono text-[12px] text-warn">bridge reads incomplete: {p.bridgeDegraded}</span>}
            </div>
            <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-ink-2">
              <span className="text-ink">{VERDICT_TEXT[verdict]}</span> The bridge locks at send and releases at delivery, so a packet in flight can only make locked exceed circulating. Kestrel reads both endpoints&apos; nonces at the same blocks to tell IN FLIGHT from OVER BACKED, and only flags UNBACKED after a second pair of fresh reads agrees.
            </p>
          </div>
          <div className="col-span-12 min-w-0 lg:col-span-5 lg:border-l lg:border-hair lg:pl-8">
            <ProportionBars
              a={{ value: p.lockedOnBase, label: "Locked in Base OFT adapter", tone: "base" }}
              b={{ value: p.rhCirculating, label: "Circulating on Robinhood Chain", tone: "rh" }}
            />
            <p className="mt-4 text-[12px] leading-relaxed text-ink-meta">
              VIBES.balanceOf(BaseAdapter) vs totalSupply() − balanceOf(ReserveAdapter), read at Base <BlockLink chainId={8453} n={p.base.number} /> and RH <BlockLink chainId={4663} n={p.robinhood.number} />
            </p>
          </div>
        </div>
      </section>

      <Panel title="Base vs Robinhood Chain" reveal={0}>
        <ComparisonTable p={p} />
      </Panel>

      <div className="grid grid-cols-12 gap-x-8 gap-y-10 max-[901px]:gap-x-4">
        <Panel title="Cross-venue dislocation" reveal={1} className="col-span-12 lg:col-span-6">
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 max-[601px]:gap-x-4">
            <Stat label="Base Aerodrome" value={fmtCompact(p.baseVibesPerWeth, 18)} tone="base" sub="VIBES per WETH" />
            <Stat className="border-l border-hair pl-6 max-[601px]:pl-4" label="RH Uniswap v3" value={fmtCompact(p.rhVibesPerWeth, 18)} tone="rh" sub="VIBES per WETH" />
          </div>
          <div className="mt-6 border-t border-hair pt-4">
            <div className="flex items-end gap-x-6 gap-y-1 max-[601px]:flex-wrap">
              <Stat size="l" label="Spread" value={p.spreadBps != null ? fmtBps(p.spreadBps) : "—"} tone={spreadAbs >= 300 ? "warn" : undefined} />
              <p className="mb-1 text-[14px] text-ink-2">{p.spreadBps == null ? "A venue read failed; no spread is shown." : p.cheaperVenue ? `VIBES trades cheaper on ${p.cheaperVenue === "base" ? "Base" : "Robinhood Chain"}.` : "Venues aligned."}</p>
            </div>
            <div className="relative mt-5 h-1.5 bg-white/[0.06]" role="img" aria-label={p.spreadBps != null ? `Spread ${fmtBps(p.spreadBps)}` : "Spread unavailable"}>
              <div className="absolute inset-y-[-4px] left-1/2 w-px bg-white/30" />
              <div
                className={`absolute inset-y-0 w-1/2 transition-transform duration-700 ease-out motion-reduce:transition-none ${(p.spreadBps ?? 0) >= 0 ? "left-1/2 origin-left bg-rh" : "right-1/2 origin-right bg-base"}`}
                style={{ transform: `scaleX(${Math.min(1, spreadAbs / 500)})` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between mono text-[11px] text-ink-meta">
              <span>cheaper on Base</span>
              <span>0</span>
              <span>cheaper on RH</span>
            </div>
          </div>
        </Panel>

        <Panel title="Arbitrage reality check" reveal={2} className="col-span-12 lg:col-span-6">
          <DataList
            rows={[
              { label: "Gross spread", value: p.spreadBps != null ? `${spreadAbs} bps` : "unavailable" },
              { label: "Pool fees (both legs)", value: bpsCell(p.feeDragBps, true) },
              { label: "Net edge before gas & bridge", value: bpsCell(p.netEdgeBpsBeforeBridge) },
              {
                label: `LayerZero fee @ ${notionalLabel}`,
                value: bpsCell(p.bridgeFeeBps, true),
                sub: p.arb ? `${ethWithUsd(p.arb.lzFeeWei, p.ethUsd, 7)} · ${p.arb.direction === "robinhood->base" ? "RH → Base" : "Base → RH"} quoteSend()` : undefined,
              },
              { label: "Gas (swap + OFT send + swap)", value: bpsCell(p.gasBps, true), sub: p.arb ? `${ethWithUsd(p.arb.gasWei, p.ethUsd, 7)} · Base ${p.gas.baseGwei} / RH ${p.gas.rhGwei} gwei` : undefined },
              {
                label: "Net edge (marginal, all costs)",
                value: bpsCell(p.netEdgeBps),
                tone: p.netEdgeBps != null && p.netEdgeBps > 0 ? "phosphor" : p.netEdgeBps != null ? "warn" : "meta",
              },
              {
                label: `Exact round trip @ ${notionalLabel}`,
                value: p.arb ? bpsCell(p.arb.reference.netEdgeBps) : "unavailable",
                sub: p.arb ? `buy · bridge · sell incl. impact · ${ethWithUsd(p.arb.reference.profitWei, p.ethUsd, 6)}` : "buy · bridge · sell incl. impact",
                tone: p.arb && Number(p.arb.reference.netEdgeBps ?? 0) > 0 ? "phosphor" : undefined,
              },
              {
                label: "Best size",
                value: p.arb ? (p.arb.optimal ? `${fmtUnits(p.arb.optimal.wethIn, 18, 4)} ETH` : "none profitable") : "unavailable",
                sub: p.arb?.optimal ? `profit ${ethWithUsd(p.arb.optimal.profitWei, p.ethUsd, 6)}` : undefined,
              },
              {
                label: `Bridge headroom (${arbLane ? chainShort(arbLane.dstChainId) : "dest"})`,
                value: arbLane?.credit ? `${fmtCompact(arbLane.credit.headroom, 18)} / ${fmtCompact(arbLane.credit.limit, 18)}` : "unavailable",
                sub: arbLane?.credit
                  ? `per ${fmtDuration(arbLane.credit.windowSec)}${p.arb && p.arb.creditWaitSec !== null && p.arb.creditWaitSec > 0 ? ` · arb size waits ${fmtDuration(p.arb.creditWaitSec)}` : ""}`
                  : undefined,
              },
            ]}
          />
          <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
            {p.netEdgeBps == null
              ? "The live LayerZero fee could not be read this refresh, so no all-in net edge is shown."
              : p.netEdgeBps > 0
                ? "The spread beats pool fees, the LayerZero fee and gas at the margin. Price impact at real size decides it: see the exact round trip."
                : "After pool fees, the live LayerZero fee and gas there is no arbitrage at the margin."}{" "}
            {p.arb && !p.arb.optimal && "No trade size is profitable on live reserves."} Gas uses live L2 gas prices; the L1 data fee is excluded. The Robinhood v3 leg uses active-range liquidity only.
          </p>
        </Panel>
      </div>

      <BridgeLaneXray p={p} />
    </div>
  );
}
