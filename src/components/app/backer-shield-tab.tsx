"use client";

import { useState } from "react";
import { Countdown } from "@/components/countdown";
import { AddrLink, ChainBadge, cx, Panel, SEVERITY_COLOR, Stat, TxLink } from "@/components/ui";
import { fmtUnits, fmtUtc } from "@/lib/format";
import type { EscrowReport, Finding, TrancheStatus } from "@/lib/engine/types";
import { useBackerShield } from "./use-api";

const STATUS_STYLE: Record<TrancheStatus, string> = {
  PAID: "border-phosphor/40 text-phosphor",
  CHALLENGE_WINDOW: "border-warn/60 text-warn",
  CLAIMABLE: "border-base/40 text-base",
  CHALLENGED: "border-crit/50 text-crit",
  ELIGIBLE: "border-base/30 text-base",
  LOCKED: "hairline text-ink-3",
  HALTED: "border-crit/40 text-crit",
};

export function BackerShieldTab({ focus }: { focus: string | null }) {
  const { data, error, isFetching } = useBackerShield();
  const [selected, setSelected] = useState<string | null>(focus);
  if (error && !data) return <Panel><p className="mono text-[13px] text-crit">Backer Shield read failed: {error.message}</p></Panel>;
  if (!data) return <Panel><p className="mono text-[13px] text-ink-3 cursor-blink">Reading every Vibestarter escrow on Base and Robinhood Chain</p></Panel>;

  const escrows = data.escrows;
  const current = escrows.find((e) => e.address.toLowerCase() === (selected ?? "").toLowerCase()) ?? escrows[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <Panel title={`Escrows · ${escrows.length}`} n="01" right={<span className="mono text-[10px] text-ink-3">{isFetching ? "refreshing…" : "factory + API, both chains"}</span>}>
        <ul className="-mx-4 -my-4 divide-y divide-white/[0.06]">
          {escrows.map((e) => {
            const win = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
            return (
              <li key={`${e.chainId}-${e.address}`}>
                <button onClick={() => setSelected(e.address)} className={cx("w-full px-4 py-3 text-left transition-colors", current?.address === e.address ? "bg-elevated" : "hover:bg-white/[0.02]")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[14px] text-ink">{e.title ?? "Untitled raise"}</span>
                    <ChainBadge chainId={e.chainId} />
                  </div>
                  <div className="mt-1 flex items-center gap-3 mono text-[11px] text-ink-3">
                    <span className={e.state === 3 ? "text-phosphor" : e.state === 7 ? "text-ink-2" : "text-warn"}>{e.stateLabel.toUpperCase()}</span>
                    <span>{fmtUnits(e.totalRaised, 18, 2)} Ξ raised</span>
                    {win && <span className="text-warn">● window open</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>
      {current && <EscrowDetail e={current} />}
    </div>
  );
}

function EscrowDetail({ e }: { e: EscrowReport & { findings: Finding[] } }) {
  const nowSec = e.oracleTime;
  const win = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
  return (
    <div className="space-y-6">
      <Panel title={e.title ? `${e.title} · tranche escrow` : "Tranche escrow"} n="02" right={<AddrLink chainId={e.chainId} address={e.address} className="text-[11px]" />}>
        {e.tagline && <p className="mb-4 text-[13px] text-ink-3">{e.tagline}</p>}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Onchain state" value={e.stateLabel} tone={e.state === 3 ? "phosphor" : [4, 5, 6].includes(e.state) ? "crit" : undefined} sub={e.apiStatus ? `API: ${e.apiStatus}` : undefined} />
          <Stat label="Raised" value={`${fmtUnits(e.totalRaised, 18, 3)} Ξ`} sub={e.raiseTypeLabel} />
          <Stat label="Still escrowed" value={`${fmtUnits(e.escrowBalance, 18, 3)} Ξ`} />
          <Stat label="Backers" value={e.contributorCount ?? "—"} sub={e.holderCount != null ? `${e.holderCount} token holders` : undefined} />
        </div>
        {win && (
          <div className="mt-5 border border-warn/40 bg-warn/[0.05] p-4">
            <p className="label text-warn">72-hour backer challenge window · {win.label}</p>
            <p className="mt-2 tnum text-[32px] text-warn">
              <Countdown to={win.windowEndsAt} initialNow={nowSec} />
            </p>
            <p className="mt-1 text-[12px] text-ink-2">
              Founder requested {fmtUnits(win.amount, 18, 4)} Ξ at {fmtUtc(win.requestedAt)}. Window closes {fmtUtc(win.windowEndsAt)}.
              {e.challengeThresholdBps != null && ` Holders of ≥ ${(e.challengeThresholdBps / 100).toFixed(2)}% of token supply may raise a challenge.`}
            </p>
            <a href={`https://app.vibestarter.xyz`} target="_blank" rel="noreferrer" className="mt-3 inline-block mono text-[11px] text-warn hover:underline">Review on Vibestarter ↗</a>
          </div>
        )}
        {e.activeChallenge && (
          <div className="mt-5 border border-crit/40 bg-crit/[0.05] p-4 text-[12px] text-ink-2">
            <p className="label text-crit">Active challenge · {e.activeChallenge.stateLabel}</p>
            <p className="mt-2">Tranche {e.activeChallenge.tranche} challenged by <AddrLink chainId={e.chainId} address={e.activeChallenge.challenger} /> at {fmtUtc(e.activeChallenge.timestamp)}.</p>
            <p className="mt-1 text-ink-3">&ldquo;{e.activeChallenge.reason}&rdquo;</p>
          </div>
        )}
      </Panel>

      <Panel title="Tranche timeline · 10% kickstart + 6 × 15% monthly" n="03">
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-7">
          {e.tranches.map((t) => (
            <li key={t.index} className={cx("border p-3", STATUS_STYLE[t.status])}>
              <p className="mono text-[10px] text-ink-3">{t.index === 0 ? "KICKSTART" : `MONTH ${t.index}`} · {t.bps / 100}%</p>
              <p className="mt-1 tnum text-[14px] text-ink">{fmtUnits(t.amount, 18, 3)} Ξ</p>
              <p className="mt-1 mono text-[10px]">{t.status.replace("_", " ")}</p>
              <p className="mt-1 mono text-[10px] text-ink-3">
                {t.status === "PAID" && t.paidTxHash ? <TxLink chainId={e.chainId} hash={t.paidTxHash} label="paid tx" /> : t.status === "CHALLENGE_WINDOW" ? <Countdown to={t.windowEndsAt} initialNow={nowSec} /> : t.unlockTime ? `unlocks ${fmtUtc(t.unlockTime).slice(0, 10)}` : "—"}
              </p>
            </li>
          ))}
        </ol>
        <p className="mt-3 mono text-[10px] text-ink-3">Read live via trancheClaimed / trancheRequestedAt / trancheChallenged / getTrancheAmount / getTrancheUnlockTime (uint8) at block #{BigInt(e.block.number).toLocaleString("en-US")} · escrow oracle time {fmtUtc(e.oracleTime)}</p>
      </Panel>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="Protections" n="04">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
            <dt className="text-ink-3">Permanent LP</dt>
            <dd className={e.lpCreated ? "text-phosphor" : "text-warn"}>{e.lpCreated ? "created" : "not created"}{e.lpWithdrawn ? " · LP ETH withdrawn" : ""} {e.lpLockTxHash && <TxLink chainId={e.chainId} hash={e.lpLockTxHash} label="lock tx" />}</dd>
            <dt className="text-ink-3">Origin Capsule</dt>
            <dd className="text-ink-2">{e.capsule ? `${e.capsule.registered ? "registered in VibesRegistry" : "not registered onchain"}${e.capsule.provenanceLabel ? ` · ${e.capsule.provenanceLabel}` : ""}${e.capsule.agentName ? ` · ${e.capsule.agentName}` : ""}` : "—"}</dd>
            <dt className="text-ink-3">Founder</dt>
            <dd><AddrLink chainId={e.chainId} address={e.founder} /></dd>
            <dt className="text-ink-3">Token</dt>
            <dd><AddrLink chainId={e.chainId} address={e.token} label={e.tokenSymbol ?? undefined} /></dd>
            {e.appHealth && (
              <>
                <dt className="text-ink-3">App health</dt>
                <dd className={e.appHealth.ok ? "text-phosphor" : "text-crit"}>HTTP {e.appHealth.status ?? "—"} · {e.appHealth.latencyMs ?? "—"} ms</dd>
              </>
            )}
          </dl>
        </Panel>
        <Panel title="Founder signals" n="05">
          {e.founderSignals ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px]">
              <dt className="text-ink-3">GitHub</dt>
              <dd className="text-ink-2">{e.founderSignals.githubUsername ? <a className="hover:text-ink" href={`https://github.com/${e.founderSignals.githubUsername}`} target="_blank" rel="noreferrer">@{e.founderSignals.githubUsername} ↗</a> : "—"}{e.founderSignals.githubCommits != null ? ` · ${e.founderSignals.githubCommits} tracked commits` : ""}</dd>
              <dt className="text-ink-3">Ethos</dt>
              <dd className="text-ink-2">{e.founderSignals.ethosScore ?? "—"}{e.founderSignals.ethosLevel ? ` · ${e.founderSignals.ethosLevel}` : ""}{e.founderSignals.humanVerified ? " · human-verified" : ""}</dd>
              <dt className="text-ink-3">X</dt>
              <dd className="text-ink-2">{e.founderSignals.xHandle ? `@${e.founderSignals.xHandle}` : "—"}{e.founderSignals.xFollowers != null ? ` · ${e.founderSignals.xFollowers.toLocaleString("en-US")} followers` : ""}</dd>
            </dl>
          ) : (
            <p className="text-[12px] text-ink-3">No founder enrichment published by Vibestarter for this raise.</p>
          )}
          <p className="mt-3 mono text-[10px] text-ink-3">Source: app.vibestarter.xyz/api/campaigns</p>
        </Panel>
      </div>

      {e.findings.length > 0 && (
        <Panel title="Shield findings" n="06">
          <ul className="space-y-2">
            {e.findings.map((f) => (
              <li key={f.id} className="flex gap-3 text-[12px]">
                <span className={cx("w-9 shrink-0 mono text-[10px] uppercase", SEVERITY_COLOR[f.severity])}>{f.severity === "critical" ? "CRIT" : f.severity === "warn" ? "WARN" : "INFO"}</span>
                <span className="text-ink-2"><span className="text-ink">{f.title}</span> — {f.detail}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
