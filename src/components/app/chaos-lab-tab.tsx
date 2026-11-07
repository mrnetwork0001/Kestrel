"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { AddrLink, ChainBadge, cx, Panel, Stat } from "@/components/ui";
import { priceImpactBps, simulateConstantProductShock } from "@/lib/amm-math";
import { fmtBps, fmtCompact, fmtUnits } from "@/lib/format";
import type { PoolSnapshot, ScanResult } from "@/lib/engine/types";
import { useParity } from "./use-api";

type Scenario = { key: string; label: string; lp: number; whaleBps: number; useTopHolder?: boolean; note: string };

const SCENARIOS: Scenario[] = [
  { key: "nominal", label: "Nominal market", lp: 0, whaleBps: 0, note: "Your exit into today's live pool." },
  { key: "whale", label: "Top whale dumps 100%", lp: 0, whaleBps: 0, useTopHolder: true, note: "Largest overnight-active holder market-sells their entire live balance first." },
  { key: "rug50", label: "50% liquidity pulled", lp: 5000, whaleBps: 0, note: "Half of the LP is withdrawn before you exit." },
  { key: "bridge", label: "OFT bridge saturated", lp: 2000, whaleBps: 100, note: "Cross-chain arbitrage can't rebalance: the local pool absorbs a 1% supply sell and 20% LP flight alone." },
  { key: "swan", label: "Black swan cascade", lp: 8000, whaleBps: 500, note: "80% LP pulled and 5% of supply dumped." },
];

function sides(p: PoolSnapshot) {
  const tokenIs0 = !p.token0.symbol.toUpperCase().includes("WETH");
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

  if (!selected) return <Panel><p className="mono text-[13px] text-ink-3 cursor-blink">Loading live pool reserves</p></Panel>;

  const s = sides(selected);
  const topHolder = scan?.flow?.topHolder && scan.token?.address.toLowerCase() === s.token.address.toLowerCase() ? scan.flow.topHolder : null;
  const defaultPosition = s.reserveToken / 100n; // 1% of pool-side tokens
  let position = defaultPosition;
  try {
    if (positionStr.trim()) position = parseUnits(positionStr.trim().replace(/,/g, ""), s.token.decimals);
  } catch {
    position = defaultPosition;
  }
  const supply = BigInt(s.token.totalSupply);
  const whaleAmount = useTop && topHolder ? BigInt(topHolder.balance) : (supply * BigInt(whaleBps)) / 10_000n;
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
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-6">
        <Panel title="Pool under test" n="01">
          <div className="flex flex-wrap gap-2">
            {pools.map((p) => (
              <button key={p.key} onClick={() => setPoolKey(p.key)} className={cx("flex items-center gap-2 rounded-[2px] border px-2.5 py-1.5 text-[12px]", p.pool.address === selected.address ? "border-phosphor/50 text-ink" : "hairline text-ink-3 hover:text-ink")}>
                <ChainBadge chainId={p.pool.chainId} />
                {p.pool.token0.symbol}/{p.pool.token1.symbol} · {p.pool.kind === "uniswap-v3" ? "Uni v3" : "Aerodrome"}
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stat label={`${s.weth.symbol} depth`} value={fmtUnits(s.reserveWeth, s.weth.decimals, 3)} />
            <Stat label={`${s.token.symbol} depth`} value={fmtCompact(s.reserveToken, s.token.decimals)} />
            <Stat label="Fee" value={`${(selected.feeBps / 100).toFixed(2)}%`} />
          </div>
          <p className="mt-3 mono text-[10px] text-ink-3">
            Seeded from block #{BigInt(selected.block.number).toLocaleString("en-US")} · <AddrLink chainId={selected.chainId} address={selected.address} />
          </p>
        </Panel>

        <Panel title="Stress scenarios" n="02">
          <div className="grid grid-cols-2 gap-2">
            {SCENARIOS.map((sc) => (
              <button
                key={sc.key}
                onClick={() => apply(sc)}
                disabled={sc.useTopHolder && !topHolder}
                className={cx("rounded-[2px] border px-3 py-2 text-left text-[12px] disabled:opacity-30", scenario === sc.key ? "border-phosphor/50 bg-phosphor/[0.05] text-ink" : "hairline text-ink-2 hover:text-ink")}
              >
                {sc.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-ink-3">{SCENARIOS.find((x) => x.key === scenario)?.note}</p>
          {!topHolder && <p className="mt-1 mono text-[10px] text-ink-3">Whale scenario needs a token scan with overnight Transfer flow (scan the token on Briefing).</p>}

          <div className="mt-5 space-y-5">
            <label className="block">
              <div className="flex justify-between"><span className="label">LP removal shock</span><span className="tnum text-[13px] text-ink">{(lp / 100).toFixed(0)}%</span></div>
              <input type="range" min={0} max={9000} step={500} value={lp} onChange={(e) => { setLp(Number(e.target.value)); setScenario("custom"); }} className="mt-2 w-full" />
            </label>
            <label className="block">
              <div className="flex justify-between">
                <span className="label">Whale market dump</span>
                <span className="tnum text-[13px] text-ink">{useTop && topHolder ? `top holder · ${fmtBps(topHolder.shareBps, false)}` : `${(whaleBps / 100).toFixed(1)}% of supply`}</span>
              </div>
              <input type="range" min={0} max={1000} step={25} value={whaleBps} onChange={(e) => { setWhaleBps(Number(e.target.value)); setUseTop(false); setScenario("custom"); }} className="mt-2 w-full" />
            </label>
            <label className="block">
              <span className="label">Your position ({s.token.symbol})</span>
              <input
                value={positionStr}
                onChange={(e) => setPositionStr(e.target.value)}
                placeholder={`${fmtUnits(defaultPosition, s.token.decimals, 0)} (1% of pool depth)`}
                className="mt-2 w-full rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[13px] text-ink placeholder:text-ink-3 focus:border-phosphor/50 focus:outline-none"
              />
            </label>
          </div>
        </Panel>
      </div>

      <div className="space-y-6">
        <Panel title="Exit outcome" n="03" right={<span className="mono text-[10px] text-ink-3">{selected.reservesAreVirtual ? "UNI V3 ACTIVE-RANGE MATH" : "x·y=k EXACT"}</span>}>
          <div className="grid grid-cols-2 gap-6">
            <Stat label="Exit before shock" value={`${fmtUnits(sim.baselineExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`} sub={`price impact ${fmtBps(impact, false)}`} />
            <Stat label="Exit after shock" value={`${fmtUnits(sim.postShockExitWeth, s.weth.decimals, 5)} ${s.weth.symbol}`} tone={sev} />
            <Stat label="Drawdown" value={fmtBps(-sim.drawdownBps)} tone={sev} />
            <Stat label="Whale extracts" value={`${fmtUnits(sim.whaleExtractedWeth, s.weth.decimals, 4)} ${s.weth.symbol}`} sub={whaleAmount > 0n ? `${fmtCompact(whaleAmount, s.token.decimals)} ${s.token.symbol} sold` : "no dump"} />
          </div>
          <div className="mt-6 border-t hairline pt-4">
            <p className="label mb-3">Exit value vs LP removal (current whale setting)</p>
            <div className="flex h-32 items-end gap-1.5">
              {curve.map((c) => {
                const h = Number((c.out * 1000n) / maxOut) / 10;
                return (
                  <div key={c.lp} className="flex flex-1 flex-col items-center gap-1">
                    <div className={cx("w-full", c.lp * 100 === lp ? "bg-phosphor" : "bg-white/15")} style={{ height: `${Math.max(2, h)}%` }} title={`${c.lp}% LP pulled → ${fmtUnits(c.out, s.weth.decimals, 5)} ${s.weth.symbol}`} />
                    <span className="mono text-[9px] text-ink-3">{c.lp}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>
        <Panel title="Model" n="04">
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
