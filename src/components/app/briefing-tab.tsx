"use client";

import Link from "next/link";
import { useState } from "react";
import { AddrLink, cx, Panel, SEVERITY_COLOR, TxLink } from "@/components/ui";
import { Kicker, SkeletonRows } from "@/components/editorial";
import { DataList, type DataRow } from "@/components/data/data-list";
import { explorerBlock, fmtBps, fmtCompact, fmtUnits } from "@/lib/format";
import type { ParityVerdict, ScanResult } from "@/lib/engine/types";
import { useBrief } from "./use-api";

const VERDICT_LABEL: Record<ParityVerdict, string> = { EXACT: "EXACT 1:1", IN_FLIGHT: "IN FLIGHT", OVER_BACKED: "OVER BACKED", UNBACKED: "UNBACKED" };

/** Split a brief into its first sentence (standfirst) and the remainder, with plain string ops only. */
function splitBrief(text: string): [string, string] {
  const t = text.trim();
  const i = t.indexOf(". ");
  if (i < 0) return [t, ""];
  return [t.slice(0, i + 1), t.slice(i + 2).trim()];
}

const SEV_WORD = { critical: "CRIT", warn: "WARN", info: "INFO" } as const;

export function BriefingTab({ scan, loading, error, onScan }: { scan: ScanResult | null; loading: boolean; error: string | null; onScan: (a: string, c: number) => void }) {
  const [wantAi, setWantAi] = useState(false);
  const ai = useBrief(scan?.target.address ?? "", scan?.target.chainId ?? 8453, wantAi && !!scan);

  if (error && !scan)
    return (
      <div className="border-t border-hair-strong pt-4">
        <p className="mono text-[13px] text-crit [overflow-wrap:anywhere]">Scan failed: {error}</p>
      </div>
    );
  if (!scan) return <SkeletonRows rows={6} caption="Reading Base & Robinhood Chain" />;

  const brief = ai.data?.brief ?? scan.brief;
  const [stand, rest] = splitBrief(brief.text);
  const t = scan.target;
  const blockNo = BigInt(scan.block.number).toLocaleString("en-US");
  const pointSum = scan.findings.reduce((s, f) => s + f.points, 0);
  const capped = pointSum !== scan.score;
  const degraded = scan.findings.find((f) => f.id === "scan-degraded");
  const sourceLabel = brief.source === "deterministic" ? "RULE-BASED · LIVE FACTS" : `${brief.source === "0g-compute" ? "0G COMPUTE" : "ANTHROPIC"}${brief.model ? ` · ${brief.model}` : ""}`;

  return (
    <div className={cx("grid grid-cols-12 gap-x-8 gap-y-8 transition-opacity max-[901px]:gap-x-4", loading && "opacity-60")}>
      {/* LEAD: Morning Desk Brief + findings ledger */}
      <div className="col-span-12 min-w-0 space-y-8 lg:col-span-7">
        {degraded && (
          <div className="border-t border-warn/50 pt-3">
            <Kicker tone="warn">Incomplete scan · re-scan to complete</Kicker>
            <p className="mt-2 text-[14px] text-ink-2">{degraded.detail}</p>
          </div>
        )}

        <article {...{ "data-rv": "up" }} className="border-t border-hair-strong pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <Kicker tone={brief.source === "deterministic" ? "meta" : "phosphor"}>Morning desk brief · {sourceLabel}</Kicker>
            <a href={explorerBlock(t.chainId, scan.block.number)} target="_blank" rel="noreferrer" className="mono text-[12px] text-ink-meta hover:text-ink max-[901px]:py-2.5">
              block #{blockNo} ↗
            </a>
          </div>
          <p className="t-stand mt-5 max-w-[34ch] text-ink [overflow-wrap:anywhere]">{stand}</p>
          {rest && <p className="mt-4 max-w-[62ch] text-[16px] leading-[1.65] text-ink-2">{rest}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => setWantAi(true)}
              disabled={ai.isFetching || (wantAi && !!ai.data)}
              className="ink-link press mono text-[12px] tracking-[0.08em] text-phosphor disabled:text-ink-meta max-[901px]:min-h-11"
            >
              {ai.isFetching ? "SYNTHESIZING…" : ai.data ? (ai.data.brief.source === "deterministic" ? "RULE-BASED BRIEF" : "AI BRIEF LOADED") : "SYNTHESIZE AI BRIEF"}
            </button>
            {ai.data?.brief.source === "deterministic" && <span className="text-[13px] text-ink-meta">No LLM configured, so this is the rule-based brief from live facts.</span>}
            {ai.error && <span className="mono text-[12px] text-crit">{ai.error.message}</span>}
          </div>
        </article>

        <section className="border-t border-hair-strong pt-4" aria-label="Findings">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="t-kicker">Findings · {scan.findings.length}</h2>
            <span className="text-[12px] text-ink-meta">points add up to the score</span>
          </div>
          <table className="mt-3 w-full border-collapse">
            <thead className="sr-only">
              <tr>
                <th>Severity</th>
                <th>Finding</th>
                <th>Points</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hair">
              {scan.findings.map((f) => (
                <tr key={f.id} className="align-top">
                  <td className={cx("w-14 py-3 pr-3 mono text-[12px] tracking-[0.08em]", SEVERITY_COLOR[f.severity])}>{SEV_WORD[f.severity]}</td>
                  <td className="min-w-0 py-3 pr-4">
                    <p className="text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">{f.title}</p>
                    <p className="mt-1 text-[14px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{f.detail}</p>
                    {f.link && (
                      <a href={f.link.href} target="_blank" rel="noreferrer" className="mt-1 inline-block mono text-[12px] text-ink-2 underline decoration-white/15 underline-offset-2 hover:text-ink max-[901px]:py-2.5">
                        {f.link.label}
                      </a>
                    )}
                  </td>
                  <td className={cx("w-12 py-3 text-right mono tnum text-[14px]", f.points > 0 ? "text-ink" : "text-ink-meta")}>+{f.points}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-hair-strong">
                <td className="py-3 pr-3 t-kicker" colSpan={2}>
                  {capped ? (
                    <>
                      Score (capped) <span className="normal-case tracking-normal text-ink-meta">· points sum {pointSum}, clamped to 0–100</span>
                    </>
                  ) : (
                    "Total"
                  )}
                </td>
                <td className="py-3 text-right mono tnum text-[18px] text-ink">{scan.score}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        {scan.wallet && <WalletExposure scan={scan} />}
      </div>

      {/* EVIDENCE: data columns */}
      <div className="col-span-12 min-w-0 space-y-8 lg:col-span-5 lg:border-l lg:border-hair lg:pl-8">
        {scan.pool && (
          <Panel title={`Liquidity · ${scan.pool.token0.symbol}/${scan.pool.token1.symbol}`} reveal={0} right={<AddrLink chainId={scan.pool.chainId} address={scan.pool.address} className="text-[12px]" />}>
            <DataList
              rows={[
                { label: `${scan.pool.token0.symbol} ${scan.pool.reservesAreVirtual ? "(active range)" : "reserve"}`, value: fmtCompact(scan.pool.reserve0, scan.pool.token0.decimals) },
                { label: `${scan.pool.token1.symbol} ${scan.pool.reservesAreVirtual ? "(active range)" : "reserve"}`, value: fmtCompact(scan.pool.reserve1, scan.pool.token1.decimals) },
                { label: `${scan.pool.token1.symbol} per ${scan.pool.token0.symbol}`, value: fmtCompact(scan.pool.token1PerToken0, 18) },
                { label: "Fee", value: `${(scan.pool.feeBps / 100).toFixed(2)}%`, sub: scan.pool.kind === "uniswap-v3" ? `Uniswap v3 · tick ${scan.pool.tick}` : `Aerodrome ${scan.pool.stable ? "stable" : "volatile"}` },
              ]}
            />
          </Panel>
        )}

        {scan.pool && (
          <Panel title={`While you slept · ${scan.pool.overnight.hours}h`} reveal={1}>
            <DataList
              rows={[
                {
                  label: "LP depth Δ",
                  value: scan.pool.overnight.reserve0ChangeBps != null ? fmtBps(scan.pool.overnight.reserve0ChangeBps) : "—",
                  tone: (scan.pool.overnight.reserve0ChangeBps ?? 0) <= -500 ? "warn" : undefined,
                },
                { label: "Price Δ", value: scan.pool.overnight.priceChangeBps != null ? fmtBps(scan.pool.overnight.priceChangeBps) : "—" },
                { label: "Swaps", value: scan.pool.overnight.swapCount ?? "—" },
              ]}
            />
            <p className="mt-2 text-[12px] leading-relaxed text-ink-meta">{scan.pool.overnight.note}</p>
          </Panel>
        )}

        {scan.flow && scan.token && (
          <Panel title={`Token flow · ${scan.token.symbol}`} reveal={2}>
            {scan.flow.available ? (
              <DataList
                rows={[
                  { label: `Transfers (${scan.flow.hours}h)`, value: scan.flow.transferCount },
                  { label: "Volume", value: fmtCompact(scan.flow.volume, scan.token.decimals) },
                  {
                    label: "Largest transfer",
                    value: fmtCompact(scan.flow.largestTransfer, scan.token.decimals),
                    sub: scan.flow.largestTransferTx ? <TxLink chainId={t.chainId} hash={scan.flow.largestTransferTx} label="tx" /> : undefined,
                  },
                  {
                    label: "Top active holder",
                    value: scan.flow.topHolder ? fmtBps(scan.flow.topHolder.shareBps, false) : "—",
                    sub: scan.flow.topHolder ? <AddrLink chainId={t.chainId} address={scan.flow.topHolder.address} /> : undefined,
                  },
                  { label: "Supply", value: scan.token.totalSupply ? `${fmtCompact(scan.token.totalSupply, scan.token.decimals)} ${scan.token.symbol}` : "—" },
                ]}
              />
            ) : (
              <p className="text-[14px] text-ink-2">{scan.flow.note}</p>
            )}
            {scan.flow.available && <p className="mt-2 text-[12px] leading-relaxed text-ink-meta">{scan.flow.note}</p>}
          </Panel>
        )}

        {scan.escrow && (
          <Panel title="Vibestarter escrow" reveal={3} right={<span className={scan.escrow.state === 3 ? "text-phosphor" : "text-warn"}>{scan.escrow.stateLabel}</span>}>
            <DataList
              rows={[
                { label: "Raised", value: `${fmtUnits(scan.escrow.totalRaised, 18, 2)} ETH` },
                { label: "Escrowed", value: `${fmtUnits(scan.escrow.escrowBalance, 18, 2)} ETH` },
                { label: "Next tranche", value: scan.escrow.nextTranche },
              ]}
            />
            <p className="mt-2 text-[13px] text-ink-2">Tranche timeline, countdowns and founder signals are in the Backer Shield tab.</p>
          </Panel>
        )}

        {scan.xray && (
          <Panel title="Bytecode & EIP-1967 X-Ray" reveal={4} right="eth_getCode · eth_getStorageAt">
            <DataList
              dense
              rows={[
                { label: "Bytecode", value: scan.xray.isContract ? `${scan.xray.byteSize.toLocaleString("en-US")} bytes` : "no code (EOA)", sub: scan.xray.isContract ? `${scan.xray.push4Count} PUSH4 selectors` : undefined },
                { label: "Impl slot", value: scan.xray.implementation ? <AddrLink chainId={t.chainId} address={scan.xray.implementation} /> : "empty", sub: scan.xray.implementation ? undefined : "not an EIP-1967 proxy" },
                { label: "Admin slot", value: scan.xray.admin ? <AddrLink chainId={t.chainId} address={scan.xray.admin} /> : "empty" },
                ...(scan.xray.eip1167CloneTarget ? [{ label: "EIP-1167", value: <AddrLink chainId={t.chainId} address={scan.xray.eip1167CloneTarget} label="immutable clone of …" /> }] : []),
                { label: "SELFDESTRUCT", value: scan.xray.hasSelfdestruct ? "present" : "absent", tone: scan.xray.hasSelfdestruct ? "warn" : "phosphor" },
                { label: "DELEGATECALL", value: scan.xray.hasDelegatecall ? "present" : "absent" },
                ...scan.xray.controllers.map(
                  (c): DataRow => ({
                    label: c.role,
                    value: c.kind === "safe" ? `SAFE ${c.safeThreshold}-of-${c.safeOwners}` : c.kind.toUpperCase(),
                    tone: c.kind === "eoa" ? "warn" : c.kind === "renounced" || c.kind === "safe" ? "phosphor" : undefined,
                    sub: c.address && c.kind !== "renounced" ? <AddrLink chainId={t.chainId} address={c.address} /> : undefined,
                  })
                ),
              ]}
            />
            {scan.xray.matchedSelectors.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Matched selectors">
                {scan.xray.matchedSelectors.map((s) => (
                  <li key={s.selector} title={s.explanation} className={cx("max-w-full mono text-[13px] [overflow-wrap:anywhere]", s.severity === "high" ? "text-crit" : s.severity === "warn" ? "text-warn" : "text-ink-2")}>
                    0x{s.selector} {s.signature}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {scan.parity && (
          <Panel
            title="Cross-chain context"
            reveal={5}
            right={
              scan.parity.rhPool ? (
                <button type="button" onClick={() => onScan(scan.parity!.rhPool?.address ?? "", 4663)} className="mono text-[12px] text-ink-2 underline decoration-white/15 underline-offset-2 hover:text-rh max-[901px]:min-h-11">
                  scan RH pool
                </button>
              ) : undefined
            }
          >
            <DataList
              rows={[
                { label: "OFT parity", value: VERDICT_LABEL[scan.parity.verdict] ?? scan.parity.verdict, tone: scan.parity.verdict === "UNBACKED" ? "crit" : scan.parity.verdict === "EXACT" ? "phosphor" : "warn" },
                { label: "Spread", value: scan.parity.spreadBps != null ? fmtBps(scan.parity.spreadBps) : "—" },
                { label: "Locked on Base", value: `${fmtCompact(scan.parity.lockedOnBase, 18)} VIBES` },
              ]}
            />
          </Panel>
        )}
      </div>
    </div>
  );
}

function WalletExposure({ scan }: { scan: ScanResult }) {
  const w = scan.wallet!;
  const t = scan.target;
  const cov = w.coverage;
  const blockNo = BigInt(scan.block.number).toLocaleString("en-US");
  return (
    <Panel
      title={`Wallet exposure${w.account ? ` · ${w.account.label}` : ""}`}
      reveal={0}
      right={
        <Link href={`/rescue?target=${t.address}&chain=${t.chainId}`} className="mono text-[12px] tracking-[0.08em] text-crit underline decoration-crit/40 underline-offset-4 hover:decoration-crit max-[901px]:inline-flex max-[901px]:min-h-11 max-[901px]:items-center">
          OPEN PANIC BUNKER
        </Link>
      }
    >
      <DataList
        rows={[
          { label: "Native ETH", value: fmtUnits(w.nativeBalance, 18, 4) },
          { label: "Live approvals", value: w.approvals.length, tone: w.approvals.some((a) => a.unlimited) ? "crit" : undefined },
          {
            label: "Spenders checked",
            value: w.spendersChecked,
            sub: w.overnightApprovalScan.available ? `${w.overnightApprovalScan.newApprovals} Approval logs in ${w.overnightApprovalScan.hours}h` : "overnight log scan n/a",
          },
          ...(cov
            ? [
                {
                  label: "Approval coverage",
                  value: `${cov.tokensChecked} tokens × ${cov.spendersChecked} spenders`,
                  sub: `${cov.erc20PairsChecked + cov.permit2PairsChecked} allowance reads · ${cov.logLookbackHours}h log window${cov.partial ? " · partial" : ""}${cov.failedCalls ? ` · ${cov.failedCalls} failed` : ""}`,
                  tone: cov.partial ? ("warn" as const) : undefined,
                },
              ]
            : []),
        ]}
      />

      {w.holdings.length > 0 && (
        <>
          <h3 className="t-kicker mt-6">Holdings</h3>
          <DataList dense className="mt-1" rows={w.holdings.map((h) => ({ label: h.symbol, value: fmtUnits(h.balance, h.decimals, 4) }))} />
        </>
      )}

      {w.approvals.length > 0 ? (
        <>
          <h3 className="t-kicker mt-6">Open approvals</h3>
          <div className="mt-1 max-w-full overflow-x-auto">
            <table className="w-full text-[13px] max-[601px]:min-w-[420px]">
              <thead>
                <tr className="text-left text-[12px] text-ink-meta">
                  <th className="py-2 font-normal">Token</th>
                  <th className="py-2 font-normal">Spender</th>
                  <th className="py-2 text-right font-normal">Allowance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hair border-t border-hair">
                {w.approvals.map((a) => (
                  <tr key={`${a.kind}-${a.token}-${a.spender}`}>
                    <td className="py-2.5 mono text-ink">{a.tokenSymbol}</td>
                    <td className="py-2.5 text-ink-2">
                      {a.spenderName} <AddrLink chainId={t.chainId} address={a.spender} className="text-[12px]" />
                    </td>
                    <td className={cx("py-2.5 text-right mono tnum", a.unlimited ? "text-crit" : "text-warn")}>{a.unlimited ? "UNLIMITED" : fmtUnits(a.amount, a.tokenDecimals, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-6 font-serif text-[22px] leading-snug text-ink">No open approvals at block #{blockNo}. Nothing to revoke.</p>
      )}
      {cov && cov.notes.length > 0 && <p className="mt-3 text-[12px] leading-relaxed text-ink-meta">{cov.notes.join(" ")}</p>}
    </Panel>
  );
}
