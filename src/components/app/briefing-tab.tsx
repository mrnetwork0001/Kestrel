"use client";

import Link from "next/link";
import { AddrLink, BandBadge, ChainBadge, cx, Panel, ScoreGauge, SEVERITY_COLOR, Stat, TxLink } from "@/components/ui";
import { explorerBlock, fmtBps, fmtCompact, fmtUnits, fmtUtc } from "@/lib/format";
import type { ScanResult } from "@/lib/engine/types";
import { ShareCard } from "@/components/share-card";
import { useBrief } from "./use-api";
import { useState } from "react";

export function BriefingTab({ scan, loading, error, onScan }: { scan: ScanResult | null; loading: boolean; error: string | null; onScan: (a: string, c: number) => void }) {
  const [wantAi, setWantAi] = useState(false);
  const ai = useBrief(scan?.target.address ?? "", scan?.target.chainId ?? 8453, wantAi && !!scan);

  if (error && !scan) return <Panel><p className="mono text-[13px] text-crit">Scan failed: {error}</p></Panel>;
  if (!scan) return <Panel><p className="mono text-[13px] text-ink-3 cursor-blink">Reading Base and Robinhood Chain</p></Panel>;

  const brief = ai.data?.brief ?? scan.brief;
  const t = scan.target;

  return (
    <div className={cx("grid gap-6 transition-opacity lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]", loading && "opacity-60")}>
      {/* LEFT: verdict */}
      <div className="space-y-6">
        <Panel
          title="Overnight threat score"
          n="01"
          right={<a href={explorerBlock(t.chainId, scan.block.number)} target="_blank" rel="noreferrer" className="mono text-[11px] text-ink-3 hover:text-ink">#{BigInt(scan.block.number).toLocaleString("en-US")} ↗</a>}
        >
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <ChainBadge chainId={t.chainId} />
            <span className="rounded-[2px] border hairline px-1.5 py-0.5 mono text-[10px] tracking-wider text-ink-2">{t.kind.toUpperCase()}</span>
            <span className="text-[15px] text-ink">{t.label}</span>
            <AddrLink chainId={t.chainId} address={t.address} className="ml-auto text-[12px]" />
          </div>
          <ScoreGauge score={scan.score} band={scan.band} />
          <p className="mt-3 mono text-[10px] text-ink-3">
            {fmtUtc(scan.block.timestamp)} · scanned in {scan.durationMs} ms · {scan.findings.length} findings
          </p>
          <ShareCard address={t.address} chainId={t.chainId} label={t.label} score={scan.score} band={scan.band} />
        </Panel>

        <Panel
          title="Morning desk brief"
          n="02"
          right={
            <span className="mono text-[10px] text-ink-3">
              {brief.source === "deterministic" ? "RULE-BASED · LIVE FACTS" : `${brief.source === "0g-compute" ? "0G COMPUTE" : "ANTHROPIC"} · ${brief.model ?? ""}`}
            </span>
          }
        >
          <p className="text-[14px] leading-relaxed text-ink-2">{brief.text}</p>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => setWantAi(true)}
              disabled={ai.isFetching || (wantAi && !!ai.data)}
              className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink hover:border-phosphor/60 hover:text-phosphor disabled:opacity-40"
            >
              {ai.isFetching ? "SYNTHESIZING…" : ai.data ? "AI BRIEF LOADED" : "SYNTHESIZE AI BRIEF"}
            </button>
            {ai.data?.brief.source === "deterministic" && <span className="mono text-[10px] text-ink-3">No LLM key configured — showing rule-based brief.</span>}
            {ai.error && <span className="mono text-[10px] text-crit">{ai.error.message}</span>}
          </div>
        </Panel>

        <Panel title="Findings" n="03" right={<span className="mono text-[10px] text-ink-3">points → score</span>}>
          <ul className="divide-y divide-white/[0.06]">
            {scan.findings.map((f) => (
              <li key={f.id} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className={cx("w-9 shrink-0 mono text-[10px] uppercase", SEVERITY_COLOR[f.severity])}>{f.severity === "critical" ? "CRIT" : f.severity === "warn" ? "WARN" : "INFO"}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">{f.title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{f.detail}</p>
                  {f.link && (
                    <a href={f.link.href} target="_blank" rel="noreferrer" className="mt-1 inline-block mono text-[11px] text-ink-2 hover:text-ink">
                      {f.link.label}
                    </a>
                  )}
                </div>
                <span className="tnum text-[12px] text-ink-3">+{f.points}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* RIGHT: evidence */}
      <div className="space-y-6">
        {scan.wallet && (
          <Panel
            title="Wallet exposure"
            n="04"
            right={
              <Link href={`/rescue?target=${t.address}&chain=${t.chainId}`} className="rounded-[2px] border border-crit/40 px-2 py-1 mono text-[10px] text-crit hover:bg-crit/10">
                OPEN PANIC BUNKER →
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Native ETH" value={fmtUnits(scan.wallet.nativeBalance, 18, 4)} />
              <Stat label="Live approvals" value={scan.wallet.approvals.length} tone={scan.wallet.approvals.some((a) => a.unlimited) ? "crit" : undefined} />
              <Stat label="Spenders checked" value={scan.wallet.spendersChecked} sub={scan.wallet.overnightApprovalScan.available ? `${scan.wallet.overnightApprovalScan.newApprovals} Approval logs in 8h` : "overnight log scan n/a"} />
            </div>
            {scan.wallet.holdings.length > 0 && (
              <table className="mt-5 w-full mono text-[12px]">
                <tbody>
                  {scan.wallet.holdings.map((h) => (
                    <tr key={h.token} className="border-t hairline">
                      <td className="py-1.5 text-ink-2">{h.symbol}</td>
                      <td className="py-1.5 text-right tnum text-ink">{fmtUnits(h.balance, h.decimals, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {scan.wallet.approvals.length > 0 && (
              <table className="mt-5 w-full text-[12px]">
                <thead>
                  <tr className="label text-left">
                    <th className="pb-2 font-normal">Token</th>
                    <th className="pb-2 font-normal">Spender</th>
                    <th className="pb-2 text-right font-normal">Allowance</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.wallet.approvals.map((a) => (
                    <tr key={`${a.kind}-${a.token}-${a.spender}`} className="border-t hairline">
                      <td className="py-1.5 mono text-ink-2">{a.tokenSymbol}</td>
                      <td className="py-1.5 text-ink-2">
                        {a.spenderName} <AddrLink chainId={t.chainId} address={a.spender} className="text-[11px]" />
                      </td>
                      <td className={cx("py-1.5 text-right tnum", a.unlimited ? "text-crit" : "text-warn")}>{a.unlimited ? "UNLIMITED" : fmtUnits(a.amount, a.tokenDecimals, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        {scan.pool && (
          <Panel title={`Liquidity · ${scan.pool.token0.symbol}/${scan.pool.token1.symbol}`} n="05" right={<AddrLink chainId={scan.pool.chainId} address={scan.pool.address} className="text-[11px]" />}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label={`${scan.pool.token0.symbol} ${scan.pool.reservesAreVirtual ? "(active range)" : "reserve"}`} value={fmtCompact(scan.pool.reserve0, scan.pool.token0.decimals)} />
              <Stat label={`${scan.pool.token1.symbol} ${scan.pool.reservesAreVirtual ? "(active range)" : "reserve"}`} value={fmtCompact(scan.pool.reserve1, scan.pool.token1.decimals)} />
              <Stat label={`${scan.pool.token1.symbol} per ${scan.pool.token0.symbol}`} value={fmtCompact(scan.pool.token1PerToken0, 18)} />
              <Stat label="Fee" value={`${(scan.pool.feeBps / 100).toFixed(2)}%`} sub={scan.pool.kind === "uniswap-v3" ? `Uniswap v3 · tick ${scan.pool.tick}` : `Aerodrome ${scan.pool.stable ? "stable" : "volatile"}`} />
            </div>
            <div className="mt-5 border-t hairline pt-4">
              <p className="label mb-2">While you slept · {scan.pool.overnight.hours}h</p>
              <div className="grid grid-cols-3 gap-4">
                <Stat label="LP depth Δ" value={scan.pool.overnight.reserve0ChangeBps != null ? fmtBps(scan.pool.overnight.reserve0ChangeBps) : "n/a"} tone={(scan.pool.overnight.reserve0ChangeBps ?? 0) <= -500 ? "warn" : undefined} />
                <Stat label="Price Δ" value={scan.pool.overnight.priceChangeBps != null ? fmtBps(scan.pool.overnight.priceChangeBps) : "n/a"} />
                <Stat label="Swaps" value={scan.pool.overnight.swapCount ?? "n/a"} />
              </div>
              <p className="mt-2 mono text-[10px] text-ink-3">{scan.pool.overnight.note}</p>
            </div>
          </Panel>
        )}

        {scan.flow && scan.token && (
          <Panel title={`Token flow · ${scan.token.symbol}`} n="06">
            {scan.flow.available ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label={`Transfers (${scan.flow.hours}h)`} value={scan.flow.transferCount} />
                <Stat label="Volume" value={fmtCompact(scan.flow.volume, scan.token.decimals)} />
                <Stat label="Largest transfer" value={fmtCompact(scan.flow.largestTransfer, scan.token.decimals)} sub={scan.flow.largestTransferTx ? <TxLink chainId={t.chainId} hash={scan.flow.largestTransferTx} label="tx" /> : undefined} />
                <Stat
                  label="Top active holder"
                  value={scan.flow.topHolder ? fmtBps(scan.flow.topHolder.shareBps, false) : "—"}
                  sub={scan.flow.topHolder ? <AddrLink chainId={t.chainId} address={scan.flow.topHolder.address} /> : undefined}
                />
              </div>
            ) : (
              <p className="mono text-[12px] text-ink-3">{scan.flow.note}</p>
            )}
            <p className="mt-3 mono text-[10px] text-ink-3">Supply {scan.token.totalSupply ? fmtCompact(scan.token.totalSupply, scan.token.decimals) : "—"} {scan.token.symbol} · {scan.flow.note}</p>
          </Panel>
        )}

        {scan.escrow && (
          <Panel title="Vibestarter escrow" n="07" right={<BandBadge band={scan.escrow.state === 3 ? "NOMINAL" : "ELEVATED"} />}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="State" value={scan.escrow.stateLabel} />
              <Stat label="Raised" value={`${fmtUnits(scan.escrow.totalRaised, 18, 2)} Ξ`} />
              <Stat label="Escrowed" value={`${fmtUnits(scan.escrow.escrowBalance, 18, 2)} Ξ`} />
              <Stat label="Next tranche" value={scan.escrow.nextTranche} />
            </div>
            <p className="mt-4 text-[12px] text-ink-3">Full tranche timeline, countdowns and founder signals live in the Backer Shield tab.</p>
          </Panel>
        )}

        {scan.xray && (
          <Panel title="Bytecode & EIP-1967 X-Ray" n="08" right={<span className="mono text-[10px] text-ink-3">eth_getCode · eth_getStorageAt</span>}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 mono text-[12px]">
              <dt className="text-ink-3">bytecode</dt>
              <dd className="text-ink-2">{scan.xray.isContract ? `${scan.xray.byteSize.toLocaleString("en-US")} bytes · ${scan.xray.push4Count} PUSH4 selectors` : "no code (EOA)"}</dd>
              <dt className="text-ink-3">impl slot</dt>
              <dd>{scan.xray.implementation ? <AddrLink chainId={t.chainId} address={scan.xray.implementation} /> : <span className="text-ink-3">empty — not an EIP-1967 proxy</span>}</dd>
              <dt className="text-ink-3">admin slot</dt>
              <dd>{scan.xray.admin ? <AddrLink chainId={t.chainId} address={scan.xray.admin} /> : <span className="text-ink-3">empty</span>}</dd>
              {scan.xray.eip1167CloneTarget && (
                <>
                  <dt className="text-ink-3">EIP-1167</dt>
                  <dd><AddrLink chainId={t.chainId} address={scan.xray.eip1167CloneTarget} label="immutable clone of …" /></dd>
                </>
              )}
              <dt className="text-ink-3">opcodes</dt>
              <dd className="text-ink-2">
                SELFDESTRUCT <span className={scan.xray.hasSelfdestruct ? "text-warn" : "text-phosphor"}>{scan.xray.hasSelfdestruct ? "present" : "absent"}</span> · DELEGATECALL{" "}
                <span className="text-ink">{scan.xray.hasDelegatecall ? "present" : "absent"}</span>
              </dd>
              {scan.xray.controllers.map((c) => (
                <div key={c.role} className="contents">
                  <dt className="text-ink-3">{c.role}</dt>
                  <dd className="text-ink-2">
                    <span className={c.kind === "eoa" ? "text-warn" : c.kind === "renounced" || c.kind === "safe" ? "text-phosphor" : "text-ink"}>
                      {c.kind === "safe" ? `SAFE ${c.safeThreshold}-of-${c.safeOwners}` : c.kind.toUpperCase()}
                    </span>{" "}
                    {c.address && c.kind !== "renounced" && <AddrLink chainId={t.chainId} address={c.address} />}
                  </dd>
                </div>
              ))}
            </dl>
            {scan.xray.matchedSelectors.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {scan.xray.matchedSelectors.map((s) => (
                  <span key={s.selector} title={s.explanation} className={cx("rounded-[2px] border px-1.5 py-0.5 mono text-[10px]", s.severity === "high" ? "border-crit/40 text-crit" : s.severity === "warn" ? "border-warn/40 text-warn" : "hairline text-ink-3")}>
                    0x{s.selector} {s.signature}
                  </span>
                ))}
              </div>
            )}
          </Panel>
        )}

        {scan.parity && (
          <Panel title="Cross-chain context" n="09" right={<button onClick={() => onScan(scan.parity!.rhPool?.address ?? "", 4663)} className="mono text-[10px] text-ink-3 hover:text-rh">scan RH pool →</button>}>
            <p className="mono text-[12px] text-ink-2">
              OFT parity <span className={scan.parity.verified ? "text-phosphor" : "text-warn"}>{scan.parity.verified ? "EXACT 1:1" : "DRIFT"}</span> · spread{" "}
              {scan.parity.spreadBps != null ? fmtBps(scan.parity.spreadBps) : "—"} · locked {fmtCompact(scan.parity.lockedOnBase, 18)} VIBES
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}
