"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { AddrLink, cx, Panel, Stat } from "@/components/ui";
import { ChainDot, SkeletonRows } from "@/components/editorial";
import { DataList } from "@/components/data/data-list";
import { CONTRACTS } from "@/config/contracts";
import { priceImpactBps, simulateConstantProductShock } from "@/lib/amm-math";
import { fmtBps, fmtCompact, fmtUnits } from "@/lib/format";
import type { PoolSnapshot, ScanResult } from "@/lib/engine/types";
import { BridgeEscapePanel, inboundLane, isParityVibesPool } from "./bridge-escape-panel";
import { usdOfWei } from "./bridge-ui";
import { useParity } from "./use-api";

type Scenario = { key: string; label: string; lp: number; whaleBps: number; useTopHolder?: boolean; floodInboundLimit?: boolean; saturate?: boolean; note: string };

const SCENARIOS: Scenario[] = [
  { key: "nominal", label: "Nominal market", lp: 0, whaleBps: 0, note: "Your exit into today's live pool." },
  { key: "whale", label: "Top whale dumps 100%", lp: 0, whaleBps: 0, useTopHolder: true, note: "The largest holder found in the scan's live Transfer flow market-sells their entire live balance first." },
  { key: "rug50", label: "50% liquidity pulled", lp: 5000, whaleBps: 0, note: "Half of the LP is withdrawn before you exit." },
  {
    key: "bridge",
    label: "OFT bridge saturated",
    lp: 0,
    whaleBps: 0,
    floodInboundLimit: true,
    saturate: true,
    note: "Max-budget flood: the most VIBES the bridge can release into this chain per window (the live credit limit, also the cap on forged-message damage) is dumped locally while the outbound lane's budget is exhausted, so cross-chain arbitrage queues at the LayerZero endpoint.",
  },
  { key: "swan", label: "Black swan cascade", lp: 8000, whaleBps: 500, note: "Hypothetical: 80% LP pulled and 5% of supply dumped." },
];

const WETH_BY_CHAIN: Record<number, string> = { 8453: CONTRACTS.base.weth.toLowerCase(), 4663: CONTRACTS.robinhood.weth.toLowerCase() };

/** Risk token vs quote (WETH) side, picked by the chain's WETH address; symbol only as a fallback. */
function sides(p: PoolSnapshot) {
  const weth = WETH_BY_CHAIN[p.chainId];
  const tokenIs0 =
    p.token1.address.toLowerCase() === weth ? true : p.token0.address.toLowerCase() === weth ? false : !p.token0.symbol.toUpperCase().includes("WETH");
  return {
    token: tokenIs0 ? p.token0 : p.token1,
    weth: tokenIs0 ? p.token1 : p.token0,
    reserveToken: BigInt(tokenIs0 ? p.reserve0 : p.reserve1),
    reserveWeth: BigInt(tokenIs0 ? p.reserve1 : p.reserve0),
  };
}

export function ChaosLabTab({ scan }: { scan: ScanResult | null }) {
  const parity = useParity();
  const pools = useMemo(() => {
    const list: { key: string; pool: PoolSnapshot }[] = [];
    if (scan?.pool) list.push({ key: `scan:${scan.pool.address}`, pool: scan.pool });
    for (const p of [parity.data?.basePool, parity.data?.rhPool]) if (p && !list.some((l) => l.pool.address.toLowerCase() === p.address.toLowerCase())) list.push({ key: `p:${p.address}`, pool: p });
    return list;
  }, [scan, parity.data]);

  const [poolKey, setPoolKey] = useState<string | null>(null);
  const selected = pools.find((p) => p.key === poolKey)?.pool ?? pools[0]?.pool ?? null;
  const [lp, setLp] = useState(0);
  const [whaleBps, setWhaleBps] = useState(0);
  const [useTop, setUseTop] = useState(false);
  const [scenario, setScenario] = useState("nominal");
  const [positionStr, setPositionStr] = useState("");
  const [saturated, setSaturated] = useState(false);
  const [flood, setFlood] = useState(false);

  if (!selected) {
    if (parity.error && !scan?.pool)
      return (
        <div className="border-t border-hair-strong pt-4">
          <p className="mono text-[13px] text-crit">Live pool reads failed: {parity.error.message}</p>
          <p className="mt-2 text-[14px] text-ink-2">Scan a token or pool on Briefing to stress-test it.</p>
        </div>
      );
    return <SkeletonRows rows={5} caption="Loading live pool reserves" />;
  }

  const s = sides(selected);
  const isWethQuote = s.weth.address.toLowerCase() === WETH_BY_CHAIN[selected.chainId];
  const ethUsd = isWethQuote ? (parity.data?.ethUsd ?? null) : null;
  const usd = (wei: bigint) => {
    const u = usdOfWei(wei, ethUsd);
    return u ? ` · ${u}` : "";
  };
  const topHolder =
    scan?.flow?.topHolder && scan.token && scan.token.chainId === selected.chainId && scan.token.address.toLowerCase() === s.token.address.toLowerCase() && BigInt(scan.flow.topHolder.balance) > 0n
      ? scan.flow.topHolder
      : null;
  const bridgeable = isParityVibesPool(parity.data, selected);
  const inLane = bridgeable ? inboundLane(parity.data, selected.chainId) : null;
  const floodAmount = flood && inLane?.credit ? BigInt(inLane.credit.limit) : null;
  const bridgeReady = bridgeable && !!inLane?.credit && !!parity.data?.bridge;
  const defaultPosition = s.reserveToken / 100n; // 1% of pool-side tokens
  let position = defaultPosition;
  try {
    if (positionStr.trim()) position = parseUnits(positionStr.trim().replace(/,/g, ""), s.token.decimals);
  } catch {
    position = defaultPosition;
  }
  const supply = BigInt(s.token.totalSupply);
  const whaleAmount = floodAmount !== null ? floodAmount : useTop && topHolder ? BigInt(topHolder.balance) : (supply * BigInt(whaleBps)) / 10_000n;
  const sim = simulateConstantProductShock({ reserveWeth: s.reserveWeth, reserveToken: s.reserveToken, whaleDumpTokenAmount: whaleAmount, lpPullBps: lp, userTokenBalance: position, feeBps: selected.feeBps });
  const impact = priceImpactBps(position, s.reserveToken, s.reserveWeth, selected.feeBps);
  const curve = Array.from({ length: 10 }, (_, i) => {
    const r = simulateConstantProductShock({ reserveWeth: s.reserveWeth, reserveToken: s.reserveToken, whaleDumpTokenAmount: whaleAmount, lpPullBps: i * 1000, userTokenBalance: position, feeBps: selected.feeBps });
    return { lp: i * 10, out: r.postShockExitWeth };
  });
  const maxOut = curve.reduce((m, c) => (c.out > m ? c.out : m), 1n);
  const sev = sim.drawdownBps >= 5000 ? "crit" : sim.drawdownBps >= 1500 ? "warn" : "phosphor";

  const apply = (sc: Scenario) => {
    setScenario(sc.key);
    setLp(sc.lp);
    setWhaleBps(sc.whaleBps);
    setUseTop(!!sc.useTopHolder);
    setFlood(!!sc.floodInboundLimit);
    setSaturated(!!sc.saturate);
  };
  const disabledReason = (sc: Scenario): string | null => {
    if (sc.useTopHolder && !topHolder) return "Needs a token scan whose live Transfer flow found a top holder (scan the token on Briefing).";
    if (sc.floodInboundLimit && !bridgeReady) {
      if (!parity.data) return parity.error ? `Live LayerZero lane read failed: ${parity.error.message}` : "Reading live LayerZero lanes…";
      return bridgeable ? "Live LayerZero lane data is unavailable this refresh." : "Only the two $VIBES venues are bridge-connected (Base Aerodrome, Robinhood Uniswap v3).";
    }
    return null;
  };
  const whaleLabel =
    floodAmount !== null
      ? `credit limit · ${fmtCompact(floodAmount, s.token.decimals)} ${s.token.symbol}${supply > 0n ? ` (${fmtBps(Number((floodAmount * 10_000n) / supply), false)})` : ""}`
      : useTop && topHolder
        ? `top holder · ${fmtBps(topHolder.shareBps, false)}`
        : `${(whaleBps / 100).toFixed(1)}% of supply`;

  const impactTone = (bps: number) => (bps >= 3000 ? "crit" : bps >= 1000 ? "warn" : undefined);
  const modelTag = selected.reservesAreVirtual ? (whaleAmount + position > s.reserveToken / 10n ? "Uni v3 active-range · indicative at this size" : "Uni v3 active-range math") : "x·y=k exact";
  const thumb =
    "mt-3 w-full max-[901px]:h-7 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-moz-range-thumb]:h-7 [&::-moz-range-thumb]:w-7";

  return (
    <div className="grid grid-cols-12 gap-x-8 gap-y-8 max-[901px]:gap-x-4">
      {/* INSTRUMENT: stress controls */}
      <div className="col-span-12 min-w-0 lg:col-span-4">
        <Panel title="Stress scenarios" variant="instrument" className="lg:sticky lg:top-24">
          <p className="t-kicker">Pool under test</p>
          <div className="mt-2 divide-y divide-hair border-y border-hair" role="radiogroup" aria-label="Pool under test">
            {pools.map((p) => {
              const on = p.pool.address === selected.address;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setPoolKey(p.key);
                    if (flood || saturated) {
                      setFlood(false);
                      setSaturated(false);
                      setScenario("custom");
                    }
                  }}
                  className={cx("press flex min-h-11 w-full items-center gap-3 text-left text-[14px] transition-colors", on ? "text-ink" : "text-ink-2 hover:text-ink")}
                >
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", on ? "bg-phosphor" : "bg-white/20")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {p.pool.token0.symbol}/{p.pool.token1.symbol} · {p.pool.kind === "uniswap-v3" ? "Uni v3" : "Aerodrome"}
                  </span>
                  <ChainDot chainId={p.pool.chainId} />
                </button>
              );
            })}
          </div>

          <p className="t-kicker mt-6">Scenario</p>
          <div className="mt-2 divide-y divide-hair border-y border-hair" role="radiogroup" aria-label="Stress scenario">
            {SCENARIOS.map((sc) => {
              const why = disabledReason(sc);
              const on = scenario === sc.key;
              return (
                <button
                  key={sc.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => apply(sc)}
                  disabled={!!why}
                  title={why ?? sc.note}
                  className={cx(
                    "press relative flex min-h-11 w-full items-center gap-3 pl-3 text-left text-[14px] transition-colors disabled:cursor-not-allowed disabled:text-ink-meta",
                    on ? "text-ink" : "text-ink-2 hover:text-ink"
                  )}
                >
                  <span className={cx("absolute inset-y-2 left-0 w-0.5 origin-center transition-transform duration-300", on ? "scale-y-100 bg-phosphor" : "scale-y-0 bg-phosphor")} aria-hidden="true" />
                  {sc.label}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{SCENARIOS.find((x) => x.key === scenario)?.note ?? "Custom shock."}</p>
          {SCENARIOS.map((sc) => ({ sc, why: disabledReason(sc) }))
            .filter((x) => x.why)
            .map(({ sc, why }) => (
              <p key={sc.key} className="mt-1.5 text-[12px] leading-relaxed text-ink-meta">
                {sc.label}: {why}
              </p>
            ))}

          <div className="mt-6 space-y-6">
            <label className="block">
              <div className="flex items-baseline justify-between gap-3">
                <span className="t-kicker">LP removal shock</span>
                <span className="mono tnum text-[15px] text-ink">{(lp / 100).toFixed(0)}%</span>
              </div>
              <input type="range" min={0} max={9000} step={500} value={lp} onChange={(e) => { setLp(Number(e.target.value)); setScenario("custom"); }} className={thumb} />
            </label>
            <label className="block">
              <div className="flex items-baseline justify-between gap-3">
                <span className="t-kicker shrink-0">Whale dump</span>
                <span className="min-w-0 text-right mono tnum text-[13px] text-ink">{whaleLabel}</span>
              </div>
              <input type="range" min={0} max={1000} step={25} value={whaleBps} onChange={(e) => { setWhaleBps(Number(e.target.value)); setUseTop(false); setFlood(false); setScenario("custom"); }} className={thumb} />
            </label>
            {bridgeReady && (
              <label className="flex min-h-11 items-start gap-3 text-[14px] text-ink-2">
                <input
                  type="checkbox"
                  checked={saturated}
                  onChange={(e) => {
                    setSaturated(e.target.checked);
                    setScenario("custom");
                  }}
                  className="mt-1 h-4 w-4 shrink-0 accent-phosphor max-[901px]:h-5 max-[901px]:w-5"
                />
                <span>
                  Saturate outbound OFT lane
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-meta">assume the {selected.chainId === 8453 ? "Base → RH" : "RH → Base"} credit budget is fully used (live headroom otherwise)</span>
                </span>
              </label>
            )}
            <label className="block">
              <span className="t-kicker">Your position ({s.token.symbol})</span>
              <input
                value={positionStr}
                onChange={(e) => setPositionStr(e.target.value)}
                placeholder={`${fmtUnits(defaultPosition, s.token.decimals, 0)} (1% of pool depth)`}
                inputMode="decimal"
                className="mt-2 h-11 w-full rounded-[2px] border border-hair-strong bg-canvas px-3 mono text-[14px] text-ink placeholder:text-ink-meta focus:border-phosphor/60 focus:outline-none max-[901px]:text-[16px]"
              />
            </label>
          </div>
        </Panel>
      </div>

      {/* LEAD: exit outcome */}
      <div className="col-span-12 min-w-0 space-y-8 lg:col-span-8">
        <Panel title="Exit outcome" reveal={0} right={<span className="mono">{modelTag}</span>}>
          <div className="grid grid-cols-12 gap-x-8 gap-y-6 max-[601px]:gap-x-4">
            <Stat
              className="col-span-12 md:col-span-6"
              size="xl"
              label="Surviving exit value"
              value={`${fmtUnits(sim.postShockExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`}
              sub={usdOfWei(sim.postShockExitWeth, ethUsd) ?? `before shock ${fmtUnits(sim.baselineExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`}
              tone={sev === "phosphor" ? undefined : sev}
            />
            <Stat className="col-span-6 md:col-span-3 md:border-l md:border-hair md:pl-6" size="l" label="Price impact" value={fmtBps(impact, false)} sub="your sell, pre-shock" tone={impactTone(impact)} />
            <Stat
              className="col-span-6 md:col-span-3 md:border-l md:border-hair md:pl-6"
              size="l"
              label="Slippage vs nominal"
              value={fmtBps(-sim.drawdownBps)}
              sub={ethUsd && sim.baselineExitWeth > sim.postShockExitWeth ? `−${usdOfWei(sim.baselineExitWeth - sim.postShockExitWeth, ethUsd)}` : "shock drawdown"}
              tone={impactTone(sim.drawdownBps)}
            />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-hair pt-4 max-[601px]:gap-x-4">
            <Stat label="Exit before shock" value={`${fmtUnits(sim.baselineExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`} sub={usd(sim.baselineExitWeth).replace(/^ · /, "") || undefined} />
            <Stat label="Whale extracts" value={`${fmtUnits(sim.whaleExtractedWeth, s.weth.decimals, 4)} ${s.weth.symbol}`} sub={whaleAmount > 0n ? `${fmtCompact(whaleAmount, s.token.decimals)} ${s.token.symbol} sold${usd(sim.whaleExtractedWeth)}` : "no dump"} />
          </div>

          <div className="mt-8">
            <div className="mb-3 flex items-baseline justify-between gap-2 max-[601px]:flex-wrap">
              <p className="t-kicker">Exit value vs LP removal</p>
              <span className="mono text-[12px] text-ink-meta">max {fmtUnits(maxOut, s.weth.decimals, 5)} {s.weth.symbol}</span>
            </div>
            <div className="flex h-36 items-stretch gap-1.5 max-[901px]:h-[200px] max-[601px]:gap-1" role="img" aria-label={`Exit value in ${s.weth.symbol} at 0% to 90% LP removal`}>
              {curve.map((c) => {
                const ratio = Number((c.out * 1000n) / maxOut) / 1000;
                const active = lp >= c.lp * 100 && lp < c.lp * 100 + 1000;
                return (
                  <div key={c.lp} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                    <div className="flex w-full flex-1 items-end" title={`${c.lp}% LP pulled → ${fmtUnits(c.out, s.weth.decimals, 5)} ${s.weth.symbol}${usd(c.out)}`}>
                      <div
                        className={cx("h-full w-full origin-bottom transition-[transform,background-color] duration-500 ease-out motion-reduce:transition-none", active ? "bg-phosphor" : "bg-white/20")}
                        style={{ transform: `scaleY(${Math.max(0.02, ratio)})` }}
                      />
                    </div>
                    <span className={cx("mono text-[11px]", active ? "text-phosphor" : "text-ink-meta")}>{c.lp}%</span>
                  </div>
                );
              })}
            </div>
          </div>
          {ethUsd && (
            <p className="mt-4 text-[12px] text-ink-meta">
              USD at live ETH/USD {usdOfWei(10n ** 18n, ethUsd)} · {ethUsd.source} slot0 · Base #{BigInt(ethUsd.block).toLocaleString("en-US")}
            </p>
          )}
        </Panel>

        <Panel title="Pool under test" reveal={1} right={<AddrLink chainId={selected.chainId} address={selected.address} className="text-[12px]" />}>
          <DataList
            rows={[
              { label: "Venue", value: `${selected.token0.symbol}/${selected.token1.symbol} · ${selected.kind === "uniswap-v3" ? "Uniswap v3" : "Aerodrome"}`, sub: <ChainDot chainId={selected.chainId} /> },
              { label: `${s.weth.symbol} depth`, value: fmtUnits(s.reserveWeth, s.weth.decimals, 3) },
              { label: `${s.token.symbol} depth`, value: fmtCompact(s.reserveToken, s.token.decimals) },
              { label: "Fee", value: `${(selected.feeBps / 100).toFixed(2)}%` },
              { label: "Seeded from block", value: `#${BigInt(selected.block.number).toLocaleString("en-US")}` },
            ]}
          />
        </Panel>

        {bridgeable && parity.data && (
          <BridgeEscapePanel parity={parity.data} selected={selected} position={position} postShock={{ reserveToken: sim.postReserveToken, reserveWeth: sim.postReserveWeth }} saturated={saturated} />
        )}

        <section className="border-t border-hair pt-3">
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 t-kicker [&::-webkit-details-marker]:hidden">
              <span className="mono transition-transform group-open:rotate-90" aria-hidden="true">›</span>
              Model
            </summary>
            <p className="max-w-[72ch] pb-2 text-[13px] leading-relaxed text-ink-2">
              <span className="mono text-ink-meta">†</span>{" "}
              {selected.reservesAreVirtual
                ? "Uniswap v3: virtual reserves x = L·2⁹⁶/√P and y = L·√P/2⁹⁶ are derived from live slot0().sqrtPriceX96 and liquidity(). Constant-product math on these is exact while the swap stays inside the active liquidity; deeper moves that cross ticks may differ."
                : "Aerodrome volatile pool: exact constant-product (x·y=k) math on live getReserves() with the pool's live fee from PoolFactory.getFee(). LP removal scales both reserves proportionally; the whale sells first, then you."}
            </p>
            <p className="max-w-[72ch] pb-2 text-[13px] leading-relaxed text-ink-2">
              <span className="mono text-ink-meta">††</span> All arithmetic is BigInt. No floating point touches a reserve; ratios are narrowed to numbers only for bar heights.
            </p>
          </details>
        </section>
      </div>
    </div>
  );
}
