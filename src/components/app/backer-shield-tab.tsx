"use client";

import { useEffect, useState } from "react";
import { Countdown } from "@/components/countdown";
import { AddrLink, ChainBadge, cx, Panel, SEVERITY_COLOR, Stat, TxLink } from "@/components/ui";
import { fmtCompact, fmtDuration, fmtUnits, fmtUtc } from "@/lib/format";
import type { EscrowNextEvent, EscrowReport, Finding, GithubVelocity, LpLockProof, TrancheStatus } from "@/lib/engine/types";
import { ChallengeCopilot } from "./challenge-copilot";
import { RefundRadar } from "./refund-radar";
import { useBackerShield } from "./use-api";

type ShieldEscrow = EscrowReport & { findings: Finding[] };
type UniverseSummary = {
  factories: { chainId: number; address: string; label: string; totalEscrows: number | null }[];
  mcp: { ok: boolean; raises: number | null; provenance: { tool: string; latencyMs: number; fetchedAt: string } | null; error: string | null };
  restCount: number;
  launches: { key: string; sources: string[]; factoryLabel: string | null; mcpStatus: string | null }[];
};

/** Ticks once a second; seeded with the server's oracle time so SSR and first paint agree. */
function useNow(initial: number): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Ago({ ts, initialNow }: { ts: number; initialNow: number }) {
  const now = useNow(initialNow);
  return <>{fmtDuration(Math.max(0, now - ts))} ago</>;
}

function TickTo({ to, initialNow, done = "now" }: { to: number; initialNow: number; done?: string }) {
  const now = useNow(initialNow);
  return <>{to - now > 0 ? fmtDuration(to - now) : done}</>;
}

function isoAgo(iso: string | null, nowSec: number): string {
  if (!iso) return "—";
  const s = Math.max(0, nowSec - Math.floor(Date.parse(iso) / 1000));
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(s / 3600);
  return h >= 1 ? `${h}h ago` : `${Math.floor(s / 60)}m ago`;
}

const pct = (bps: number | null | undefined, digits = 2) => (bps == null ? "—" : `${(bps / 100).toFixed(digits)}%`);

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

  const escrows = data.escrows as ShieldEscrow[];
  const universe = (data as typeof data & { universe?: UniverseSummary | null }).universe ?? null;
  const current = escrows.find((e) => e.address.toLowerCase() === (selected ?? "").toLowerCase()) ?? escrows[0];

  return (
    <div className="min-w-0 space-y-6">
      {universe && <UniverseStrip u={universe} count={escrows.length} />}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Panel title={`Escrows · ${escrows.length}`} n="01" right={<span className="mono text-[10px] text-ink-3">{isFetching ? "refreshing…" : "live · both chains"}</span>}>
          <ul className="-mx-4 -my-4 divide-y divide-white/[0.06] max-[901px]:max-h-[min(60vh,440px)] max-[901px]:overflow-y-auto max-[901px]:overscroll-contain max-[601px]:-mx-3 max-[601px]:-my-3">
            {escrows.map((e) => {
              const win = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
              const ne = e.nextEvent;
              return (
                <li key={`${e.chainId}-${e.address}`}>
                  <button onClick={() => setSelected(e.address)} className={cx("w-full px-4 py-3 text-left transition-colors max-[601px]:px-3", current?.address === e.address && current.chainId === e.chainId ? "bg-elevated" : "hover:bg-white/[0.02]")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14px] text-ink">{e.title ?? "Untitled raise"}</span>
                      <ChainBadge chainId={e.chainId} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 mono text-[11px] text-ink-3">
                      <span className={e.state === 3 ? "text-phosphor" : e.state === 7 ? "text-ink-2" : e.state === 1 ? "text-base" : "text-warn"}>{e.stateLabel.toUpperCase()}</span>
                      <span>{fmtUnits(e.totalRaised, 18, 2)} Ξ raised</span>
                      {win && <span className="text-warn">● window open</span>}
                      {e.lpLock?.status === "verified" && <span className="text-phosphor">LP {(e.lpLock.lockedShareBps ?? 0) >= 9999 ? "≈100%" : pct(e.lpLock.lockedShareBps)} locked ✓</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 mono text-[10px] text-ink-3">
                      {ne?.at ? (
                        <span className={ne.kind === "window-closes" ? "text-warn" : "text-ink-2"}>
                          {ne.label} in <TickTo to={ne.at} initialNow={e.oracleTime} />
                        </span>
                      ) : ne ? (
                        <span className="text-ink-2">{ne.label}</span>
                      ) : null}
                      {e.appHealth && (
                        <span className={e.appHealth.ok ? "text-phosphor" : "text-crit"}>
                          app {e.appHealth.status ?? "down"}
                          {e.appHealth.latencyMs != null ? ` · ${e.appHealth.latencyMs}ms` : ""}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
        {current && <EscrowDetail key={`${current.chainId}:${current.address}`} e={current} />}
      </div>
    </div>
  );
}

function UniverseStrip({ u, count }: { u: UniverseSummary; count: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border hairline bg-surface px-4 py-3 mono text-[10px] text-ink-3 max-[601px]:gap-x-3 max-[601px]:px-3">
      <span className="text-ink-2">LAUNCH UNIVERSE · {count} escrows</span>
      {u.factories.map((f) => (
        <span key={`${f.chainId}:${f.address}`} className="flex min-w-0 flex-wrap items-center gap-1.5 break-all">
          <ChainBadge chainId={f.chainId} />
          <AddrLink chainId={f.chainId} address={f.address} label={f.label} className="text-[10px]" />
          <span className="text-ink-2">getAllEscrows = {f.totalEscrows ?? "unavailable"}</span>
        </span>
      ))}
      <span>REST /api/campaigns = {u.restCount}</span>
      {u.mcp.ok ? (
        <span className="text-phosphor">
          Vibestarter MCP list_raises = {u.mcp.raises}
          {u.mcp.provenance ? ` · ${u.mcp.provenance.latencyMs} ms` : ""}
        </span>
      ) : (
        <span className="text-warn">Vibestarter MCP unavailable{u.mcp.error ? `: ${u.mcp.error}` : ""}</span>
      )}
    </div>
  );
}

function EscrowDetail({ e }: { e: ShieldEscrow }) {
  const nowSec = e.oracleTime;
  const win = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
  const vsUrl = e.vibestarterUrl ?? "https://app.vibestarter.xyz";
  return (
    <div className="min-w-0 space-y-6">
      <Panel title={e.title ? `${e.title} · tranche escrow` : "Tranche escrow"} n="02" right={<AddrLink chainId={e.chainId} address={e.address} className="text-[11px]" />}>
        {e.tagline && <p className="mb-4 text-[13px] text-ink-3 max-[601px]:mb-3">{e.tagline}</p>}
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 mono text-[10px] text-ink-3">
          <a href={vsUrl} target="_blank" rel="noreferrer" className="text-ink-2 hover:text-ink max-[901px]:inline-flex max-[901px]:min-h-[36px] max-[901px]:items-center">Raise page on Vibestarter ↗</a>
          {e.generation && e.generation !== "unknown" && (
            <span>escrow {e.generation} · {e.generation === "v1" ? "challenges need a Vibestarter terms signature · 72 h auto-expiry" : "challenges gated by onchain eligibility registry · 7 d adjudication"}</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Onchain state" value={e.stateLabel} tone={e.state === 3 ? "phosphor" : [4, 5, 6].includes(e.state) ? "crit" : undefined} sub={e.apiStatus ? `API: ${e.apiStatus}` : undefined} />
          <Stat label="Raised" value={`${fmtUnits(e.totalRaised, 18, 3)} Ξ`} sub={e.raiseTypeLabel} />
          <Stat label="Still escrowed" value={`${fmtUnits(e.escrowBalance, 18, 3)} Ξ`} />
          <Stat label="Backers" value={e.contributorCount ?? "—"} sub={e.holderCount != null ? `${e.holderCount} token holders` : undefined} />
        </div>
        {win && (
          <div className="mt-5 border border-warn/40 bg-warn/[0.05] p-4 max-[601px]:p-3">
            <p className="label text-warn">72-hour backer challenge window · {win.label}</p>
            <p className="mt-2 tnum text-[32px] text-warn max-[601px]:text-[28px]">
              <Countdown to={win.windowEndsAt} initialNow={nowSec} />
            </p>
            <p className="mt-1 text-[12px] text-ink-2">
              Founder requested {fmtUnits(win.amount, 18, 4)} Ξ at {fmtUtc(win.requestedAt)}. Window closes {fmtUtc(win.windowEndsAt)}.
              {e.challengeThresholdBps != null && ` Holders of ≥ ${(e.challengeThresholdBps / 100).toFixed(2)}% of token supply may raise a challenge.`}
            </p>
            <a href={vsUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block mono text-[11px] text-warn hover:underline max-[901px]:inline-flex max-[901px]:min-h-[36px] max-[901px]:items-center">Review on Vibestarter ↗</a>
          </div>
        )}
        {!win && e.nextEvent && <NextEventBlock ev={e.nextEvent} nowSec={nowSec} />}
        {e.lastWindow && !e.lastWindow.open && (
          <p className="mt-3 text-[12px] text-ink-3">
            Last window: <span className="text-ink-2">{e.lastWindow.label}</span> ({fmtUnits(e.lastWindow.amount, 18, 4)} Ξ) requested {fmtUtc(e.lastWindow.requestedAt)}, window closed{" "}
            <span className="text-ink-2"><Ago ts={e.lastWindow.windowEndsAt} initialNow={nowSec} /></span> —{" "}
            <span className={e.lastWindow.challenged ? "text-crit" : "text-phosphor"}>{e.lastWindow.challenged ? "challenged" : "unchallenged"}</span>
            {e.lastWindow.claimed ? ", paid out." : ", not yet claimed."}
          </p>
        )}
        {e.activeChallenge && (
          <div className="mt-5 border border-crit/40 bg-crit/[0.05] p-4 text-[12px] text-ink-2">
            <p className="label text-crit">Active challenge · {e.activeChallenge.stateLabel}</p>
            <p className="mt-2">Tranche {e.activeChallenge.tranche} challenged by <AddrLink chainId={e.chainId} address={e.activeChallenge.challenger} /> at {fmtUtc(e.activeChallenge.timestamp)}.</p>
            <p className="mt-1 text-ink-3">&ldquo;{e.activeChallenge.reason}&rdquo;</p>
          </div>
        )}
        {e.lastChallenge && (
          <p className="mt-3 text-[12px] text-ink-3">
            Previous challenge on Month {e.lastChallenge.tranche} by <AddrLink chainId={e.chainId} address={e.lastChallenge.challenger} /> ({fmtUtc(e.lastChallenge.timestamp)}) was{" "}
            <span className={e.lastChallenge.state === 2 ? "text-crit" : "text-ink-2"}>{e.lastChallenge.stateLabel.toLowerCase()}</span>: &ldquo;{e.lastChallenge.reason}&rdquo;
          </p>
        )}
        {/* <=600px: the nested co-pilot panel bleeds to this panel's edges so its own boxes get the width back. */}
        <div className="mt-5 max-[601px]:-mx-3">
          <ChallengeCopilot escrow={e.address} chainId={e.chainId} title={e.title} />
        </div>
      </Panel>

      <Panel title="Tranche timeline · 10% kickstart + 6 × 15% of escrowed funds" n="03">
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-7 max-[601px]:flex max-[601px]:snap-x max-[601px]:snap-mandatory max-[601px]:overflow-x-auto max-[601px]:overscroll-x-contain max-[601px]:pb-2">
          {e.tranches.map((t) => {
            const isNext = e.nextEvent?.tranche === t.index && e.nextEvent.kind === "tranche-unlock";
            return (
              <li key={t.index} className={cx("border p-3 max-[601px]:w-[140px] max-[601px]:shrink-0 max-[601px]:snap-start", STATUS_STYLE[t.status], isNext && "border-base/60")}>
                <p className="mono text-[10px] text-ink-3">{t.index === 0 ? "KICKSTART" : `MONTH ${t.index}`}</p>
                <p className="mt-1 tnum text-[14px] text-ink">{fmtUnits(t.amount, 18, 3)} Ξ</p>
                <p className="mt-0.5 mono text-[10px] text-ink-3" title="Share of escrowed funds · share of total raise (escrow holds 85%; 15% went to permanent LP)">
                  {t.bps / 100}% esc{t.bpsOfRaised != null && BigInt(t.amount) > 0n ? ` · ${pct(t.bpsOfRaised)} raise` : ""}
                </p>
                <p className="mt-1 mono text-[10px]">{t.status.replace("_", " ")}</p>
                <p className="mt-1 mono text-[10px] text-ink-3">
                  {t.status === "PAID" && t.paidTxHash ? (
                    <TxLink chainId={e.chainId} hash={t.paidTxHash} label="paid tx" />
                  ) : t.status === "CHALLENGE_WINDOW" ? (
                    <Countdown to={t.windowEndsAt} initialNow={nowSec} />
                  ) : isNext ? (
                    <span className="text-base">in <TickTo to={t.unlockTime} initialNow={nowSec} /></span>
                  ) : t.unlockTime && t.status !== "HALTED" ? (
                    `unlocks ${fmtUtc(t.unlockTime).slice(0, 10)}`
                  ) : (
                    "—"
                  )}
                </p>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 mono text-[10px] text-ink-3">
          % esc = share of the escrowed 85%; % raise = amount ÷ total raised (BigInt). Read live via trancheClaimed / trancheRequestedAt / trancheChallenged / getTrancheAmount / getTrancheUnlockTime (uint8) at block #{BigInt(e.block.number).toLocaleString("en-US")} · escrow oracle time {fmtUtc(e.oracleTime)}
        </p>
      </Panel>

      {e.refund && (
        <Panel title={`Refund Radar · ${e.refund.mode === "contributor" ? "failed raise" : "holder refunds"}`} n="04">
          <RefundRadar e={e} />
        </Panel>
      )}

      <Panel title="Proof-of-Lock · permanent LP verified onchain" n="05" right={e.lpLock?.block ? <span className="mono text-[10px] text-ink-3">block #{BigInt(e.lpLock.block).toLocaleString("en-US")}</span> : undefined}>
        <ProofOfLock e={e} />
      </Panel>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Panel title="Founder app & GitHub velocity" n="06">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] [overflow-wrap:anywhere] gap-x-4 gap-y-2 text-[12px]">
            <dt className="text-ink-3">App health</dt>
            <dd>
              {e.appHealth ? (
                <span className={e.appHealth.ok ? "text-phosphor" : "text-crit"}>
                  {e.appHealth.ok ? "● UP" : "● DOWN"} · HTTP {e.appHealth.status ?? "—"} · {e.appHealth.latencyMs != null ? `${e.appHealth.latencyMs} ms` : e.appHealth.error ?? "no response"}
                </span>
              ) : (
                <span className="text-ink-3">{e.appUrl ? "probe unavailable" : "no app URL published by Vibestarter"}</span>
              )}
              {e.appUrl && (
                <a href={e.appUrl} target="_blank" rel="noreferrer nofollow" className="ml-2 mono text-[10px] text-ink-3 hover:text-ink">
                  {e.appUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
                </a>
              )}
              {e.appHealth?.checkedAt && <span className="ml-2 mono text-[10px] text-ink-3">probed {isoAgo(e.appHealth.checkedAt, nowSec)}</span>}
            </dd>
            <dt className="text-ink-3">GitHub</dt>
            <dd className="text-ink-2">
              <GithubBlock g={e.founderGithub ?? null} fallbackLogin={e.founderSignals?.githubUsername ?? null} nowSec={nowSec} />
            </dd>
            {e.repoUrl && (
              <>
                <dt className="text-ink-3">Capsule repo</dt>
                <dd className="text-ink-2">
                  <a href={e.repoUrl} target="_blank" rel="noreferrer nofollow" className="hover:text-ink">{e.repoUrl.replace(/^https:\/\/github\.com\//, "")} ↗</a>
                  {e.founderGithub?.capsuleRepo && (
                    <span className={cx("ml-2", e.founderGithub.capsuleRepo.status === "not-found" ? "text-warn" : "text-ink-3")}>
                      {e.founderGithub.capsuleRepo.status === "ok"
                        ? `last push ${isoAgo(e.founderGithub.capsuleRepo.pushedAt, nowSec)}${e.founderGithub.capsuleRepo.archived ? " · archived" : ""}`
                        : e.founderGithub.capsuleRepo.status === "not-found"
                          ? "private or deleted (GitHub 404)"
                          : "unavailable"}
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          <p className="mt-3 mono text-[10px] text-ink-3">App probed live from Kestrel&apos;s server (5 s timeout, 60 s cache) · GitHub public REST API (30 min cache)</p>
        </Panel>
        <Panel title="Protections & founder signals" n="07">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] [overflow-wrap:anywhere] gap-x-4 gap-y-2 text-[12px]">
            <dt className="text-ink-3">LP ETH</dt>
            <dd className={e.lpWithdrawn ? "text-phosphor" : "text-ink-3"}>{e.lpWithdrawn ? "routed to locker ✓ (prerequisite for any tranche claim)" : "not routed yet"}</dd>
            <dt className="text-ink-3">Origin Capsule</dt>
            <dd className="text-ink-2">{e.capsule ? `${e.capsule.registered ? "registered in VibesRegistry" : "not registered onchain"}${e.capsule.provenanceLabel ? ` · ${e.capsule.provenanceLabel}` : ""}${e.capsule.agentName ? ` · ${e.capsule.agentName}` : ""}` : "—"}</dd>
            <dt className="text-ink-3">Founder</dt>
            <dd><AddrLink chainId={e.chainId} address={e.founder} /></dd>
            <dt className="text-ink-3">Token</dt>
            <dd><AddrLink chainId={e.chainId} address={e.token} label={e.tokenSymbol ?? undefined} /></dd>
            {e.backerTokensUnclaimed != null && BigInt(e.backerTokensUnclaimed) > 0n && (
              <>
                <dt className="text-ink-3">Unclaimed backer tokens</dt>
                <dd className="text-ink-2">{fmtCompact(e.backerTokensUnclaimed, e.tokenDecimals ?? 18)} {e.tokenSymbol ?? ""} held by the launch router for backers</dd>
              </>
            )}
            {e.founderSignals && (
              <>
                <dt className="text-ink-3">Ethos</dt>
                <dd className="text-ink-2">{e.founderSignals.ethosScore ?? "—"}{e.founderSignals.ethosLevel ? ` · ${e.founderSignals.ethosLevel}` : ""}{e.founderSignals.humanVerified ? " · human-verified" : ""}</dd>
                <dt className="text-ink-3">X</dt>
                <dd className="text-ink-2">{e.founderSignals.xHandle ? `@${e.founderSignals.xHandle}` : "—"}{e.founderSignals.xFollowers != null ? ` · ${e.founderSignals.xFollowers.toLocaleString("en-US")} followers` : ""}</dd>
              </>
            )}
          </dl>
          <p className="mt-3 mono text-[10px] text-ink-3">Sources: escrow + router RPC reads · app.vibestarter.xyz/api/campaigns/by-tx detail</p>
        </Panel>
      </div>

      {e.findings.length > 0 && (
        <Panel title="Shield findings" n="08">
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

const NEXT_TONE: Record<EscrowNextEvent["kind"], string> = {
  "raise-deadline": "border-base/40 bg-base/[0.04] text-base",
  "window-closes": "border-warn/40 bg-warn/[0.05] text-warn",
  "challenge-adjudication": "border-crit/40 bg-crit/[0.05] text-crit",
  "tranche-unlock": "border-base/40 bg-base/[0.04] text-base",
  "awaiting-request": "border-base/40 bg-base/[0.04] text-base",
  "awaiting-claim": "border-phosphor/30 bg-phosphor/[0.03] text-phosphor",
  "refund-sweep": "border-warn/40 bg-warn/[0.05] text-warn",
};

function NextEventBlock({ ev, nowSec }: { ev: EscrowNextEvent; nowSec: number }) {
  return (
    <div className={cx("mt-5 border p-4 max-[601px]:p-3", NEXT_TONE[ev.kind])}>
      <p className="label">
        Next · {ev.label}
        {ev.amount && BigInt(ev.amount) > 0n ? ` · ${fmtUnits(ev.amount, 18, 4)} Ξ` : ""}
      </p>
      {ev.at ? (
        <>
          <p className="mt-2 tnum text-[32px] max-[601px]:text-[28px]">
            <TickTo to={ev.at} initialNow={nowSec} done="due now" />
          </p>
          <p className="mt-1 mono text-[11px] text-ink-3">{fmtUtc(ev.at)}</p>
        </>
      ) : (
        <p className="mt-2 tnum text-[20px]">no fixed time</p>
      )}
      <p className="mt-1 text-[12px] text-ink-2">{ev.detail}</p>
    </div>
  );
}

function ProofOfLock({ e }: { e: ShieldEscrow }) {
  const l: LpLockProof | null = e.lpLock ?? null;
  if (!l) {
    return (
      <p className="text-[12px] text-ink-3">
        {e.state === 4 ? "Raise failed before finalization — no liquidity pool was ever created, so there is nothing to lock." : e.state === 1 ? "Raise still collecting — the permanent LP is created at finalization." : "No LP lock read for this escrow."}
      </p>
    );
  }
  if (l.status !== "verified") {
    return (
      <div className="text-[12px]">
        <p className={l.status === "unavailable" ? "text-ink-3" : "text-crit"}>{l.status === "rescued" ? "LP RESCUED — not permanently locked" : l.status === "not-locked" ? "NOT LOCKED" : "Proof-of-Lock unavailable"}</p>
        <p className="mt-1 text-ink-3">{l.note}</p>
        {l.routerLpStatusLabel && <p className="mt-1 mono text-[10px] text-ink-3">router.lpStatus(token) = {l.routerLpStatusLabel}</p>}
      </div>
    );
  }
  const share = l.lockedShareBps ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Pool LP soulbound" value={share >= 9999 ? "≈100%" : pct(l.lockedShareBps)} tone="phosphor" sub={l.unlockedShareBps != null ? `max ever removable: ${pct(l.unlockedShareBps)}` : undefined} />
        <Stat label="ETH paired at lock" value={l.ethPaired ? `${fmtUnits(l.ethPaired, 18, 4)} Ξ` : "—"} sub={l.tokensPaired ? `${fmtCompact(l.tokensPaired, e.tokenDecimals ?? 18)} ${e.tokenSymbol ?? ""}` : undefined} />
        <Stat label="Fee claimer" value={l.claimerIsImmutableClone ? "Immutable ✓" : l.claimerIsImmutableClone === false ? "Non-standard" : "—"} tone={l.claimerIsImmutableClone ? "phosphor" : "warn"} sub="EIP-1167 clone · no withdraw path" />
        <Stat label="Locked" value={l.lockedAt ? fmtUtc(l.lockedAt).slice(0, 10) : "—"} sub={l.lockerVersion ? `VibesLPLocker${l.lockerVersion === "v2" ? "V2" : " v1"}` : undefined} />
      </div>
      <div className="h-2 w-full overflow-hidden rounded-[1px] bg-white/[0.06]" aria-label={`Locked share ${pct(l.lockedShareBps)}`}>
        <div className="h-full bg-phosphor" style={{ width: `${Math.min(100, share / 100)}%` }} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] [overflow-wrap:anywhere] gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-ink-3">verifyLPLocked()</dt>
        <dd className="text-phosphor">true · {l.lpLocked ? fmtUnits(l.lpLocked, 18, 3) : "—"} of {l.lpTotalSupply ? fmtUnits(l.lpTotalSupply, 18, 3) : "—"} LP</dd>
        {l.locker && (
          <>
            <dt className="text-ink-3">Locker</dt>
            <dd><AddrLink chainId={l.chainId} address={l.locker} label={`VibesLPLocker${l.lockerVersion === "v2" ? "V2" : " v1"}`} /></dd>
          </>
        )}
        {l.feeClaimer && (
          <>
            <dt className="text-ink-3">LP holder</dt>
            <dd><AddrLink chainId={l.chainId} address={l.feeClaimer} label="VibesLPFeeClaimer clone" /></dd>
          </>
        )}
        {l.pool && (
          <>
            <dt className="text-ink-3">Pool</dt>
            <dd><AddrLink chainId={l.chainId} address={l.pool} /></dd>
          </>
        )}
        {l.routerLpStatusLabel && (
          <>
            <dt className="text-ink-3">Router lpStatus</dt>
            <dd className={l.routerLpStatus === 1 ? "text-phosphor" : "text-warn"}>{l.routerLpStatusLabel}</dd>
          </>
        )}
        {l.lockTx && (
          <>
            <dt className="text-ink-3">Lock tx</dt>
            <dd className={l.lockTx.verified ? "text-phosphor" : "text-warn"}>
              <TxLink chainId={l.chainId} hash={l.lockTx.hash} label={l.lockTx.verified ? "receipt verified ✓" : "receipt not verified"} />
              <span className="ml-2 text-ink-3">{l.lockTx.note}</span>
            </dd>
          </>
        )}
      </dl>
      <p className="text-[12px] text-ink-2">{l.note}</p>
    </div>
  );
}

function GithubBlock({ g, fallbackLogin, nowSec }: { g: GithubVelocity | null; fallbackLogin: string | null; nowSec: number }) {
  if (!g) return <span className="text-ink-3">{fallbackLogin ? `@${fallbackLogin}` : "no GitHub identity published by Vibestarter"}</span>;
  const link = (
    <a className="hover:text-ink" href={g.profileUrl} target="_blank" rel="noreferrer nofollow">
      @{g.login} ↗
    </a>
  );
  if (g.status !== "ok") {
    return (
      <span>
        {link} <span className={g.status === "rate-limited" ? "text-warn" : "text-ink-3"}>· {g.note}</span>
      </span>
    );
  }
  const stale = g.lastPushAt ? nowSec - Math.floor(Date.parse(g.lastPushAt) / 1000) > 30 * 86400 : true;
  return (
    <div className="space-y-1">
      <div>
        {link} <span className={stale ? "text-warn" : "text-phosphor"}>· last push {g.lastPushAt ? isoAgo(g.lastPushAt, nowSec) : "none in 90 d"}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 tnum">
        <span>
          <span className="text-ink">{g.pushes7d ?? "—"}</span>
          <span className="text-ink-3"> / {g.pushes30d ?? "—"}</span>
          <span className="block mono text-[10px] text-ink-3">pushes 7d / 30d</span>
        </span>
        <span>
          <span className="text-ink">{g.commits7d ?? "—"}</span>
          <span className="text-ink-3"> / {g.commits30d ?? "—"}{g.commitsCapped ? "+" : ""}</span>
          <span className="block mono text-[10px] text-ink-3">commits 7d / 30d</span>
        </span>
        <span>
          <span className="text-ink">{g.activeDays30d ?? "—"}</span>
          <span className="block mono text-[10px] text-ink-3">active days 30d</span>
        </span>
      </div>
      {g.reposPushed30d.length > 0 && <div className="mono text-[10px] text-ink-3">repos: {g.reposPushed30d.slice(0, 4).join(" · ")}</div>}
      <div className="mono text-[10px] text-ink-3">commits = landed in the top repos @{g.login} pushed to · public repos only · fetched {isoAgo(g.fetchedAt, nowSec)}</div>
    </div>
  );
}
