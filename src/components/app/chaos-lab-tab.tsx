"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { AddrLink, ChainBadge, cx, Panel, Stat } from "@/components/ui";
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
    if (parity.error && !scan?.pool) return <Panel><p className="mono text-[13px] text-crit">Live pool reads failed: {parity.error.message}. Scan a token or pool on Briefing to stress-test it.</p></Panel>;
    return <Panel><p className="mono text-[13px] text-ink-3 cursor-blink">Loading live pool reserves</p></Panel>;
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

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] max-[601px]:gap-4">
      <div className="min-w-0 space-y-6 max-[601px]:space-y-4">
        <Panel title="Pool under test" n="01">
          <div className="flex flex-wrap gap-2">
            {pools.map((p) => (
              <button
                key={p.key}
                onClick={() => {
                  setPoolKey(p.key);
                  if (flood || saturated) {
                    setFlood(false);
                    setSaturated(false);
                    setScenario("custom");
                  }
                }}
                className={cx("flex max-w-full items-center gap-2 rounded-[2px] border px-2.5 py-1.5 text-left text-[12px] max-[901px]:min-h-10", p.pool.address === selected.address ? "border-phosphor/50 text-ink" : "hairline text-ink-3 hover:text-ink")}>
                <ChainBadge chainId={p.pool.chainId} />
                {p.pool.token0.symbol}/{p.pool.token1.symbol} · {p.pool.kind === "uniswap-v3" ? "Uni v3" : "Aerodrome"}
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4 max-[601px]:gap-3">
            <Stat label={`${s.weth.symbol} depth`} value={fmtUnits(s.reserveWeth, s.weth.decimals, 3)} />
            <Stat label={`${s.token.symbol} depth`} value={fmtCompact(s.reserveToken, s.token.decimals)} />
            <Stat label="Fee" value={`${(selected.feeBps / 100).toFixed(2)}%`} />
          </div>
          <p className="mt-3 mono text-[10px] text-ink-3">
            Seeded from block #{BigInt(selected.block.number).toLocaleString("en-US")} · <AddrLink chainId={selected.chainId} address={selected.address} />
          </p>
        </Panel>

        <Panel title="Stress scenarios" n="02">
          <div className="grid grid-cols-2 gap-2 max-[380px]:grid-cols-1">
            {SCENARIOS.map((sc) => {
              const why = disabledReason(sc);
              return (
                <button
                  key={sc.key}
                  onClick={() => apply(sc)}
                  disabled={!!why}
                  title={why ?? sc.note}
                  className={cx("rounded-[2px] border px-3 py-2 text-left text-[12px] disabled:opacity-30 max-[901px]:min-h-11", scenario === sc.key ? "border-phosphor/50 bg-phosphor/[0.05] text-ink" : "hairline text-ink-2 hover:text-ink")}
                >
                  {sc.label}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[12px] text-ink-3">{SCENARIOS.find((x) => x.key === scenario)?.note ?? "Custom shock."}</p>
          {SCENARIOS.map((sc) => ({ sc, why: disabledReason(sc) }))
            .filter((x) => x.why)
            .map(({ sc, why }) => (
              <p key={sc.key} className="mt-1 mono text-[10px] text-ink-3">
                {sc.label}: {why}
              </p>
            ))}

          <div className="mt-5 space-y-5">
            <label className="block">
              <div className="flex justify-between gap-3"><span className="label">LP removal shock</span><span className="tnum text-[13px] text-ink">{(lp / 100).toFixed(0)}%</span></div>
              <input type="range" min={0} max={9000} step={500} value={lp} onChange={(e) => { setLp(Number(e.target.value)); setScenario("custom"); }} className="mt-2 w-full max-[901px]:h-7" />
            </label>
            <label className="block">
              <div className="flex justify-between gap-3">
                <span className="label shrink-0">Whale market dump</span>
                <span className="min-w-0 text-right tnum text-[13px] text-ink">{whaleLabel}</span>
              </div>
              <input type="range" min={0} max={1000} step={25} value={whaleBps} onChange={(e) => { setWhaleBps(Number(e.target.value)); setUseTop(false); setFlood(false); setScenario("custom"); }} className="mt-2 w-full max-[901px]:h-7" />
            </label>
            {bridgeReady && (
              <label className="flex items-start gap-2 text-[12px] text-ink-2 max-[901px]:min-h-9 max-[901px]:py-1">
                <input
                  type="checkbox"
                  checked={saturated}
                  onChange={(e) => {
                    setSaturated(e.target.checked);
                    setScenario("custom");
                  }}
                  className="mt-0.5 accent-phosphor max-[901px]:h-5 max-[901px]:w-5 max-[901px]:shrink-0"
                />
                <span>
                  Saturate outbound OFT lane
                  <span className="block mono text-[10px] text-ink-3">assume the {selected.chainId === 8453 ? "Base → RH" : "RH → Base"} credit budget is fully used (live headroom otherwise)</span>
                </span>
              </label>
            )}
            <label className="block">
              <span className="label">Your position ({s.token.symbol})</span>
              <input
                value={positionStr}
                onChange={(e) => setPositionStr(e.target.value)}
                placeholder={`${fmtUnits(defaultPosition, s.token.decimals, 0)} (1% of pool depth)`}
                inputMode="decimal"
                className="mt-2 w-full rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[13px] text-ink placeholder:text-ink-3 focus:border-phosphor/50 focus:outline-none max-[901px]:min-h-11 max-[901px]:text-[16px]"
              />
            </label>
          </div>
        </Panel>
      </div>

      <div className="min-w-0 space-y-6 max-[601px]:space-y-4">
        <Panel title="Exit outcome" n="03" right={<span className="mono text-[10px] text-ink-3">{selected.reservesAreVirtual ? (whaleAmount + position > s.reserveToken / 10n ? "UNI V3 ACTIVE-RANGE · INDICATIVE AT THIS SIZE" : "UNI V3 ACTIVE-RANGE MATH") : "x·y=k EXACT"}</span>}>
          <div className="grid grid-cols-2 gap-6 max-[601px]:gap-4">
            <Stat label="Exit before shock" value={`${fmtUnits(sim.baselineExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`} sub={`price impact ${fmtBps(impact, false)}${usd(sim.baselineExitWeth)}`} />
            <Stat label="Exit after shock" value={`${fmtUnits(sim.postShockExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`} sub={usdOfWei(sim.postShockExitWeth, ethUsd) ?? undefined} tone={sev} />
            <Stat label="Drawdown" value={fmtBps(-sim.drawdownBps)} sub={ethUsd && sim.baselineExitWeth > sim.postShockExitWeth ? `−${usdOfWei(sim.baselineExitWeth - sim.postShockExitWeth, ethUsd)}` : undefined} tone={sev} />
            <Stat label="Whale extracts" value={`${fmtUnits(sim.whaleExtractedWeth, s.weth.decimals, 4)} ${s.weth.symbol}`} sub={whaleAmount > 0n ? `${fmtCompact(whaleAmount, s.token.decimals)} ${s.token.symbol} sold${usd(sim.whaleExtractedWeth)}` : "no dump"} />
          </div>
          {ethUsd && (
            <p className="mt-3 mono text-[10px] text-ink-3">
              USD at live ETH/USD {usdOfWei(10n ** 18n, ethUsd)} · {ethUsd.source} slot0 · Base #{BigInt(ethUsd.block).toLocaleString("en-US")}
            </p>
          )}
          <div className="mt-6 border-t hairline pt-4">
            <div className="mb-3 flex items-baseline justify-between gap-2 max-[601px]:flex-wrap">
              <p className="label">Exit value vs LP removal (current whale setting)</p>
              <span className="mono text-[10px] text-ink-3">max {fmtUnits(maxOut, s.weth.decimals, 5)} {s.weth.symbol}</span>
            </div>
            <div className="flex h-32 items-stretch gap-1.5 max-[901px]:h-[220px] max-[601px]:h-[200px] max-[601px]:gap-1" role="img" aria-label={`Exit value in ${s.weth.symbol} at 0% to 90% LP removal`}>
              {curve.map((c) => {
                const h = Number((c.out * 1000n) / maxOut) / 10;
                const active = lp >= c.lp * 100 && lp < c.lp * 100 + 1000;
                return (
                  <div key={c.lp} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className={cx("w-full", active ? "bg-phosphor" : "bg-white/20")}
                        style={{ height: `${Math.max(2, h)}%` }}
                        title={`${c.lp}% LP pulled → ${fmtUnits(c.out, s.weth.decimals, 5)} ${s.weth.symbol}${usd(c.out)}`}
                      />
                    </div>
                    <span className={cx("mono text-[9px]", active ? "text-phosphor" : "text-ink-3")}>{c.lp}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>
        {bridgeable && parity.data && (
          <BridgeEscapePanel
            parity={parity.data}
            selected={selected}
            position={position}
            postShock={{ reserveToken: sim.postReserveToken, reserveWeth: sim.postReserveWeth }}
            saturated={saturated}
            n="04"
          />
        )}
        <Panel title="Model" n={bridgeable && parity.data ? "05" : "04"}>
          <p className="text-[12px] leading-relaxed text-ink-3">
            {selected.reservesAreVirtual
              ? "Uniswap v3: virtual reserves x = L·2⁹⁶/√P and y = L·√P/2⁹⁶ are derived from live slot0().sqrtPriceX96 and liquidity(). Constant-product math on these is exact while the swap stays inside the active liquidity; deeper moves that cross ticks may differ."
              : "Aerodrome volatile pool: exact constant-product (x·y=k) math on live getReserves() with the pool's live fee from PoolFactory.getFee(). LP removal scales both reserves proportionally; the whale sells first, then you."}{" "}
            All arithmetic is BigInt — no floating point touches a reserve.
          </p>
        </Panel>
      </div>
    </div>
  );
}
