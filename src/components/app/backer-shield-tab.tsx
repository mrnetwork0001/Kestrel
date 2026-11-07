"use client";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Countdown } from "@/components/countdown";
import { TrancheRuler } from "@/components/data/tranche-ruler";
import { ChainDot, Kicker, SkeletonRows } from "@/components/editorial";
import { AddrLink, ChainBadge, cx, SEVERITY_COLOR, TxLink } from "@/components/ui";
import { explorerAddress, fmtCompact, fmtDuration, fmtUnits, fmtUtc } from "@/lib/format";
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

const TONE_TEXT = { phosphor: "text-phosphor", warn: "text-warn", crit: "text-crit", base: "text-base", rh: "text-rh" } as const;
type Tone = keyof typeof TONE_TEXT;

/** Unboxed figure: kicker label, mono value, 12px meta sub-line. Columns are split by hairlines, never boxes. */
function Fig({ label, value, sub, tone, size = "m" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; size?: "s" | "m" | "l" }) {
  return (
    <div className="min-w-0">
      <p className="t-kicker">{label}</p>
      <p className={cx("mt-2 tnum leading-none [overflow-wrap:anywhere]", size === "l" ? "text-[40px] max-[601px]:text-[30px]" : size === "s" ? "text-[16px]" : "text-[24px] max-[601px]:text-[20px]", tone ? TONE_TEXT[tone] : "text-ink")}>{value}</p>
      {sub && <p className="mt-1.5 mono text-[12px] leading-snug text-ink-meta">{sub}</p>}
    </div>
  );
}

/** PAPER section: 1px strong top rule, kicker title, optional right meta. No border, no fill. */
function Sec({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("min-w-0 border-t border-hair-strong pt-4", className)}>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="t-kicker text-ink-2">{title}</h3>
        {right && <div className="mono text-[12px] text-ink-meta">{right}</div>}
      </header>
      {children}
    </section>
  );
}

const STATE_TONE = (s: number) => (s === 3 ? "text-phosphor" : s === 7 ? "text-ink-2" : s === 1 ? "text-base" : [4, 5, 6].includes(s) ? "text-crit" : "text-warn");

const SEG_TEXT: Record<TrancheStatus, string> = {
  PAID: "text-phosphor",
  CHALLENGE_WINDOW: "text-warn",
  CHALLENGED: "text-crit",
  HALTED: "text-crit",
  CLAIMABLE: "text-base",
  ELIGIBLE: "text-base",
  LOCKED: "text-ink-meta",
};

/** Ruled ledger under the ruler: per-tranche amount, shares, status and the paid-tx proof link. */
function TrancheLedger({ e, nextIndex }: { e: ShieldEscrow; nextIndex: number | null }) {
  return (
    <details className="group mt-5">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 mono text-[12px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">›</span>
        Tranche ledger · amounts, shares and paid-tx proofs
      </summary>
      <table className="mt-2 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-hair-strong mono text-[11px] uppercase tracking-[0.12em] text-ink-meta">
            <th className="py-2 pr-3 font-normal">Tranche</th>
            <th className="py-2 pr-3 text-right font-normal">Amount</th>
            <th className="py-2 pr-3 text-right font-normal max-[601px]:hidden">Share</th>
            <th className="py-2 pr-3 font-normal">Status</th>
            <th className="py-2 font-normal">Proof / date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hair">
          {e.tranches.map((t) => (
            <tr key={t.index} className="mono text-[12px]">
              <td className={cx("py-2.5 pr-3", nextIndex === t.index ? "text-base" : "text-ink-2")}>{t.index === 0 ? "Kickstart" : `Month ${t.index}`}</td>
              <td className="py-2.5 pr-3 text-right tnum text-ink">{fmtUnits(t.amount, 18, 3)} Ξ</td>
              <td className="py-2.5 pr-3 text-right text-ink-meta max-[601px]:hidden" title="Share of escrowed funds · share of total raise (escrow holds 85%; 15% went to permanent LP)">
                {t.bps / 100}%{t.bpsOfRaised != null && BigInt(t.amount) > 0n ? ` · ${pct(t.bpsOfRaised)}` : ""}
              </td>
              <td className={cx("py-2.5 pr-3", SEG_TEXT[t.status])}>{t.status.replace("_", " ")}</td>
              <td className="py-2.5 text-ink-meta">
                {t.status === "PAID" && t.paidTxHash ? (
                  <TxLink chainId={e.chainId} hash={t.paidTxHash} label="paid tx" className="text-[12px]" />
                ) : t.status === "CHALLENGE_WINDOW" && t.windowEndsAt ? (
                  <span className="text-warn">closes {fmtUtc(t.windowEndsAt)}</span>
                ) : t.unlockTime && t.status !== "HALTED" ? (
                  `unlocks ${fmtUtc(t.unlockTime).slice(0, 10)}`
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function nextLine(ne: EscrowNextEvent | null): string | null {
  if (!ne) return null;
  return ne.at ? `${ne.label} · ${fmtUtc(ne.at).slice(0, 10)}` : ne.label;
}

export function BackerShieldTab({ focus }: { focus: string | null }) {
  const { data, error, isFetching } = useBackerShield();
  const [selected, setSelected] = useState<string | null>(focus);
  if (error && !data)
    return (
      <div className="border-t border-hair-strong pt-4">
        <p className="mono text-[13px] text-crit">Backer Shield read failed: {error.message}</p>
      </div>
    );
  if (!data) return <SkeletonRows rows={6} heights={[64, 64, 64, 40, 40, 40]} caption="Reading every Vibestarter escrow on Base and Robinhood Chain" />;

  const escrows = data.escrows as ShieldEscrow[];
  const universe = (data as typeof data & { universe?: UniverseSummary | null }).universe ?? null;
  const current = escrows.find((e) => e.address.toLowerCase() === (selected ?? "").toLowerCase()) ?? escrows[0];

  return (
    <div className="min-w-0 space-y-6">
      {universe && <UniverseLine u={universe} count={escrows.length} />}
      <div className="grid grid-cols-1 gap-x-8 gap-y-8 min-[901px]:grid-cols-12">
        <aside className="min-w-0 min-[901px]:sticky min-[901px]:top-24 min-[901px]:col-span-4 min-[901px]:self-start min-[901px]:max-h-[calc(100vh-112px)] min-[901px]:overflow-y-auto min-[901px]:overscroll-contain" aria-label="Vibestarter escrows">
          <div className="flex items-baseline justify-between gap-3 border-t border-hair-strong pt-4">
            <Kicker as="h2" tone="meta">
              Escrows · {escrows.length}
            </Kicker>
            <span className="mono text-[12px] text-ink-meta">{isFetching ? "refreshing…" : "live · both chains"}</span>
          </div>
          <ul className="mt-3 divide-y divide-hair border-b border-hair max-[900px]:-mx-1 max-[900px]:flex max-[900px]:snap-x max-[900px]:snap-mandatory max-[900px]:divide-x max-[900px]:divide-y-0 max-[900px]:overflow-x-auto max-[900px]:overscroll-x-contain max-[900px]:border-y">
            {escrows.map((e) => {
              const active = current?.address === e.address && current.chainId === e.chainId;
              const win = e.tranches.some((t) => t.status === "CHALLENGE_WINDOW");
              const line = nextLine(e.nextEvent ?? null);
              return (
                <li key={`${e.chainId}-${e.address}`} className="min-w-0 max-[900px]:w-[240px] max-[900px]:shrink-0 max-[900px]:snap-start">
                  <button type="button" onClick={() => setSelected(e.address)} aria-current={active ? "true" : undefined} className="idx-row w-full py-4 pl-4 pr-2 text-left max-[900px]:h-full max-[900px]:min-h-[44px]">
                    {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-phosphor" />}
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="idx-title min-w-0 truncate font-serif text-[20px] leading-tight text-ink">{e.title ?? "Untitled raise"}</span>
                      <ChainDot chainId={e.chainId} />
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 mono text-[12px]">
                      <span className={cx("tracking-wider", STATE_TONE(e.state))}>{e.stateLabel.toUpperCase()}</span>
                      <span className="idx-fig text-ink-2">{fmtUnits(e.totalRaised, 18, 2)} Ξ raised</span>
                      {win && <span className="text-warn">window open</span>}
                    </span>
                    {line && <span className={cx("mt-1 block truncate text-[13px]", e.nextEvent?.kind === "window-closes" ? "text-warn" : "text-ink-2")}>{line}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        {current && (
          <div className="min-w-0 min-[901px]:col-span-8">
            <EscrowDetail key={`${current.chainId}:${current.address}`} e={current} />
          </div>
        )}
      </div>
    </div>
  );
}

function UniverseLine({ u, count }: { u: UniverseSummary; count: number }) {
  const factoryVersion = (label: string) => {
    const v = /\(v(\d)/.exec(label)?.[1];
    return v ? ` v${v}` : "";
  };
  const chainTag = (id: number) => (id === 4663 ? "RH" : id === 8453 ? "Base" : String(id));
  return (
    <p className="t-meta min-w-0 truncate max-[901px]:whitespace-normal max-[901px]:[overflow-wrap:anywhere]">
      <span className="text-ink-2">Launch universe · {count} escrows</span>
      {u.factories.map((f) => (
        <span key={`${f.chainId}:${f.address}`}>
          {" · "}
          <a href={explorerAddress(f.chainId, f.address)} target="_blank" rel="noreferrer" title={`${f.label} · getAllEscrows()`} className="hover:text-ink">
            {chainTag(f.chainId)}{factoryVersion(f.label)} factory {f.totalEscrows ?? "—"} ↗
          </a>
        </span>
      ))}
      <span>{` · REST ${u.restCount}`}</span>
      {u.mcp.ok ? (
        <span className="text-phosphor" title="Vibestarter MCP list_raises">{` · MCP ${u.mcp.raises ?? "—"}${u.mcp.provenance ? ` (${u.mcp.provenance.latencyMs} ms)` : ""}`}</span>
      ) : (
        <span className="text-warn" title={u.mcp.error ?? undefined}>{" · MCP unavailable"}</span>
      )}
    </p>
  );
}

function EscrowDetail({ e }: { e: ShieldEscrow }) {
  const nowSec = e.oracleTime;
  const win = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
  const vsUrl = e.vibestarterUrl ?? "https://app.vibestarter.xyz";
  const nextIndex = e.nextEvent?.kind === "tranche-unlock" ? e.nextEvent.tranche : win ? win.index : null;
  return (
    <div className="min-w-0 space-y-10">
      {/* 1 · Escrow masthead */}
      <header className="min-w-0">
        <Kicker tone="meta" led={<ChainBadge chainId={e.chainId} />}>
          Tranche escrow{e.generation && e.generation !== "unknown" ? ` · ${e.generation}` : ""}
        </Kicker>
        <h2 className="mt-4 font-serif text-[36px] leading-[1.05] text-ink [overflow-wrap:anywhere] max-[601px]:text-[30px]">{e.title ?? "Untitled raise"}</h2>
        {e.tagline && <p className="mt-3 max-w-[62ch] text-[16px] leading-relaxed text-ink-2">{e.tagline}</p>}
        <p className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 mono text-[12px] text-ink-meta">
          <AddrLink chainId={e.chainId} address={e.address} n={6} className="text-[12px]" />
          <a href={vsUrl} target="_blank" rel="noreferrer" className="ink-link text-ink-2 hover:text-ink max-[901px]:inline-flex max-[901px]:min-h-[44px] max-[901px]:items-center">
            Raise page on Vibestarter <span className="text-ink-meta">↗</span>
          </a>
          {e.generation && e.generation !== "unknown" && <span>{e.generation === "v1" ? "challenges need a Vibestarter terms signature · 72 h auto-expiry" : "challenges gated by onchain eligibility registry · 7 d adjudication"}</span>}
        </p>
        <div className="mt-6 grid grid-cols-2 gap-y-5 border-y border-hair py-5 md:grid-cols-4">
          {[
            <Fig key="s" label="State" value={e.stateLabel} tone={e.state === 3 ? "phosphor" : [4, 5, 6].includes(e.state) ? "crit" : undefined} sub={e.apiStatus ? `API: ${e.apiStatus}` : undefined} />,
            <Fig key="r" label="Raised" value={`${fmtUnits(e.totalRaised, 18, 3)} Ξ`} sub={e.raiseTypeLabel} />,
            <Fig key="e" label="Still escrowed" value={`${fmtUnits(e.escrowBalance, 18, 3)} Ξ`} />,
            <Fig key="b" label="Backers" value={e.contributorCount ?? "—"} sub={e.holderCount != null ? `${e.holderCount} token holders` : undefined} />,
          ].map((f, i) => (
            <div key={i} className={cx("min-w-0 pr-4", i % 2 === 1 && "border-l border-hair pl-5", i > 1 && "md:border-l md:border-hair md:pl-5", i === 2 && "max-md:pl-0")}>
              {f}
            </div>
          ))}
        </div>
      </header>

      {/* 2 · NEXT: the tab's single countdown */}
      <section className="min-w-0" aria-label="Next escrow event">
        {win ? (
          <>
            <Kicker tone="warn" led={<span aria-hidden="true" className="dot-live inline-block h-1.5 w-1.5 rounded-[1px] bg-warn" />}>
              72h challenge window closes · {win.label}
            </Kicker>
            <p className="mt-4 tnum text-[48px] leading-none text-warn max-[601px]:text-[40px]">
              <Countdown to={win.windowEndsAt} initialNow={nowSec} />
            </p>
            <p className="mt-2 mono text-[13px] text-ink-meta">{fmtUtc(win.windowEndsAt)}</p>
            <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">
              Founder requested {fmtUnits(win.amount, 18, 4)} Ξ at {fmtUtc(win.requestedAt)}.
              {e.challengeThresholdBps != null && ` Holders of ≥ ${(e.challengeThresholdBps / 100).toFixed(2)}% of token supply may raise a challenge.`}{" "}
              <a href={vsUrl} target="_blank" rel="noreferrer" className="ink-link text-warn max-[901px]:inline-flex max-[901px]:min-h-[44px] max-[901px]:items-center">
                Review on Vibestarter <span>↗</span>
              </a>
            </p>
          </>
        ) : e.nextEvent ? (
          <NextFigure ev={e.nextEvent} nowSec={nowSec} />
        ) : (
          <p className="font-serif text-[22px] text-ink-2">No upcoming escrow event at block #{BigInt(e.block.number).toLocaleString("en-US")}.</p>
        )}
        {e.lastWindow && !e.lastWindow.open && (
          <p className="mt-4 max-w-[70ch] text-[13px] leading-relaxed text-ink-meta">
            Last window: <span className="text-ink-2">{e.lastWindow.label}</span> ({fmtUnits(e.lastWindow.amount, 18, 4)} Ξ) requested {fmtUtc(e.lastWindow.requestedAt)}, window closed <span className="text-ink-2">{fmtUtc(e.lastWindow.windowEndsAt)}</span>{" "}
            · <span className={e.lastWindow.challenged ? "text-crit" : "text-phosphor"}>{e.lastWindow.challenged ? "challenged" : "unchallenged"}</span>
            {e.lastWindow.claimed ? ", paid out." : ", not yet claimed."}
          </p>
        )}
        {e.activeChallenge && (
          <div className="mt-5 border-l-2 border-crit pl-4 text-[13px] text-ink-2">
            <p className="t-kicker text-crit">Active challenge · {e.activeChallenge.stateLabel}</p>
            <p className="mt-2">
              Tranche {e.activeChallenge.tranche} challenged by <AddrLink chainId={e.chainId} address={e.activeChallenge.challenger} /> at {fmtUtc(e.activeChallenge.timestamp)}.
            </p>
            <p className="mt-1 text-ink-2">&ldquo;{e.activeChallenge.reason}&rdquo;</p>
          </div>
        )}
        {e.lastChallenge && (
          <p className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-ink-meta">
            Previous challenge on Month {e.lastChallenge.tranche} by <AddrLink chainId={e.chainId} address={e.lastChallenge.challenger} /> ({fmtUtc(e.lastChallenge.timestamp)}) was{" "}
            <span className={e.lastChallenge.state === 2 ? "text-crit" : "text-ink-2"}>{e.lastChallenge.stateLabel.toLowerCase()}</span>: &ldquo;{e.lastChallenge.reason}&rdquo;
          </p>
        )}
      </section>

      {/* 3 · Tranche ruler */}
      <Sec title="Tranches · 10% kickstart + 6 × 15% of escrowed funds" right={<>block #{BigInt(e.block.number).toLocaleString("en-US")}</>}>
        <TrancheRuler tranches={e.tranches} size="l" showAmounts showDates />
        <TrancheLedger e={e} nextIndex={nextIndex} />
        <p className="mt-4 mono text-[12px] leading-relaxed text-ink-meta">
          Share = % of the escrowed 85% · amount ÷ total raised (BigInt). Read live via trancheClaimed / trancheRequestedAt / trancheChallenged / getTrancheAmount / getTrancheUnlockTime (uint8) · escrow oracle time {fmtUtc(e.oracleTime)}
        </p>
      </Sec>

      {/* 4 · Challenge Co-pilot (instrument) */}
      <ChallengeCopilot escrow={e.address} chainId={e.chainId} title={e.title} />

      {/* 5 · Dossier */}
      <div className="min-w-0">
        <Kicker as="h2">Dossier</Kicker>
        <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-2">
          {e.refund && (
            <Sec title={`Refund Radar · ${e.refund.mode === "contributor" ? "failed raise" : "holder refunds"}`} className="md:col-span-2">
              <RefundRadar e={e} />
            </Sec>
          )}
          <Sec title="Proof-of-Lock · permanent LP" right={e.lpLock?.block ? <>block #{BigInt(e.lpLock.block).toLocaleString("en-US")}</> : undefined} className="md:col-span-2">
            <ProofOfLock e={e} />
          </Sec>
          <Sec title="Founder app & GitHub">
            <dl className="divide-y divide-hair text-[13px] [overflow-wrap:anywhere]">
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 py-2.5">
                <dt className="text-ink-2">App health</dt>
                <dd className="min-w-0">
                  <AppHealthLine e={e} nowSec={nowSec} />
                </dd>
              </div>
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 py-2.5">
                <dt className="text-ink-2">GitHub</dt>
                <dd className="min-w-0 text-ink-2">
                  <GithubBlock g={e.founderGithub ?? null} fallbackLogin={e.founderSignals?.githubUsername ?? null} nowSec={nowSec} />
                </dd>
              </div>
              {e.repoUrl && (
                <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 py-2.5">
                  <dt className="text-ink-2">Capsule repo</dt>
                  <dd className="min-w-0 text-ink-2">
                    <a href={e.repoUrl} target="_blank" rel="noreferrer nofollow" className="mono text-[12px] hover:text-ink">
                      {e.repoUrl.replace(/^https:\/\/github\.com\//, "")} <span className="text-ink-meta">↗</span>
                    </a>
                    {e.founderGithub?.capsuleRepo && (
                      <span className={cx("block mono text-[12px]", e.founderGithub.capsuleRepo.status === "not-found" ? "text-warn" : "text-ink-meta")}>
                        {e.founderGithub.capsuleRepo.status === "ok"
                          ? `last push ${isoAgo(e.founderGithub.capsuleRepo.pushedAt, nowSec)}${e.founderGithub.capsuleRepo.archived ? " · archived" : ""}`
                          : e.founderGithub.capsuleRepo.status === "not-found"
                            ? "private or deleted (GitHub 404)"
                            : "unavailable"}
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-3 mono text-[12px] text-ink-meta">App probed live from Kestrel&apos;s server (5 s timeout, 60 s cache) · GitHub public REST API (30 min cache)</p>
          </Sec>
          <Sec title="Protections & signals">
            <dl className="divide-y divide-hair text-[13px] [overflow-wrap:anywhere]">
              {(
                [
                  ["LP ETH", <span key="v" className={e.lpWithdrawn ? "text-phosphor" : "text-ink-meta"}>{e.lpWithdrawn ? "routed to locker ✓ (prerequisite for any tranche claim)" : "not routed yet"}</span>],
                  ["Origin Capsule", e.capsule ? `${e.capsule.registered ? "registered in VibesRegistry" : "not registered onchain"}${e.capsule.provenanceLabel ? ` · ${e.capsule.provenanceLabel}` : ""}${e.capsule.agentName ? ` · ${e.capsule.agentName}` : ""}` : "—"],
                  ["Founder", <AddrLink key="f" chainId={e.chainId} address={e.founder} />],
                  ["Token", <AddrLink key="t" chainId={e.chainId} address={e.token} label={e.tokenSymbol ?? undefined} />],
                  ...(e.backerTokensUnclaimed != null && BigInt(e.backerTokensUnclaimed) > 0n
                    ? ([["Unclaimed backer tokens", `${fmtCompact(e.backerTokensUnclaimed, e.tokenDecimals ?? 18)} ${e.tokenSymbol ?? ""} held by the launch router for backers`]] as [string, ReactNode][])
                    : []),
                  ...(e.founderSignals
                    ? ([
                        ["Ethos", `${e.founderSignals.ethosScore ?? "—"}${e.founderSignals.ethosLevel ? ` · ${e.founderSignals.ethosLevel}` : ""}${e.founderSignals.humanVerified ? " · human-verified" : ""}`],
                        ["X", `${e.founderSignals.xHandle ? `@${e.founderSignals.xHandle}` : "—"}${e.founderSignals.xFollowers != null ? ` · ${e.founderSignals.xFollowers.toLocaleString("en-US")} followers` : ""}`],
                      ] as [string, ReactNode][])
                    : []),
                ] as [string, ReactNode][]
              ).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 py-2.5">
                  <dt className="text-ink-2">{k}</dt>
                  <dd className="min-w-0 text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 mono text-[12px] text-ink-meta">Sources: escrow + router RPC reads · app.vibestarter.xyz/api/campaigns/by-tx detail</p>
          </Sec>
          {e.findings.length > 0 && (
            <Sec title={`Shield findings · ${e.findings.length}`} className="md:col-span-2">
              <ul className="divide-y divide-hair">
                {e.findings.map((f) => (
                  <li key={f.id} className="grid grid-cols-[48px_minmax(0,1fr)] gap-x-3 py-2.5 text-[14px]">
                    <span className={cx("pt-0.5 mono text-[12px] uppercase", f.severity === "info" ? "text-ink-meta" : SEVERITY_COLOR[f.severity])}>{f.severity === "critical" ? "CRIT" : f.severity === "warn" ? "WARN" : "INFO"}</span>
                    <span className="min-w-0 text-ink-2">
                      <span className="text-ink">{f.title}</span> · {f.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </Sec>
          )}
        </div>
      </div>
    </div>
  );
}

function AppHealthLine({ e, nowSec }: { e: ShieldEscrow; nowSec: number }) {
  const h = e.appHealth;
  const redirect = h?.ok && h.error ? /redirects to (\S+)/.exec(h.error)?.[1] : undefined;
  const host = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <span className="mono text-[12px]">
      {h ? (
        <span className={h.ok ? "text-phosphor" : "text-crit"}>
          {h.ok ? "● UP" : "● DOWN"} · HTTP {h.status ?? "—"}
          {redirect ? ` → ${host(redirect)}` : ""}
          {h.latencyMs != null ? ` · ${h.latencyMs} ms` : !h.ok ? ` · ${h.error ?? "no response"}` : ""}
        </span>
      ) : (
        <span className="text-ink-meta">{e.appUrl ? "probe unavailable" : "no app URL published by Vibestarter"}</span>
      )}
      {e.appUrl && (
        <a href={e.appUrl} target="_blank" rel="noreferrer nofollow" className="block text-ink-2 hover:text-ink" title={redirect ? h?.error ?? undefined : undefined}>
          {host(e.appUrl)} <span className="text-ink-meta">↗</span>
        </a>
      )}
      {h?.checkedAt && <span className="block text-ink-meta">probed {isoAgo(h.checkedAt, nowSec)}</span>}
    </span>
  );
}

function NextFigure({ ev, nowSec }: { ev: EscrowNextEvent; nowSec: number }) {
  const hot = ev.kind === "window-closes" || ev.kind === "refund-sweep";
  const crit = ev.kind === "challenge-adjudication";
  const tone = crit ? "crit" : hot ? "warn" : ev.kind === "awaiting-claim" ? "phosphor" : "base";
  const amount = ev.amount && BigInt(ev.amount) > 0n ? ` · ${fmtUnits(ev.amount, 18, 4)} Ξ` : "";
  return (
    <>
      <Kicker tone={tone}>
        Next · {ev.label}
        {amount}
      </Kicker>
      {ev.at ? (
        <>
          <p className={cx("mt-4 tnum text-[48px] leading-none max-[601px]:text-[40px]", TONE_TEXT[tone])}>
            <TickTo to={ev.at} initialNow={nowSec} done="due now" />
          </p>
          <p className="mt-2 mono text-[13px] text-ink-meta">{fmtUtc(ev.at)}</p>
        </>
      ) : (
        <p className={cx("mt-4 font-serif text-[28px] leading-tight", TONE_TEXT[tone])}>No fixed time</p>
      )}
      <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">{ev.detail}</p>
    </>
  );
}

function ProofOfLock({ e }: { e: ShieldEscrow }) {
  const l: LpLockProof | null = e.lpLock ?? null;
  if (!l) {
    return (
      <p className="text-[12px] text-ink-meta">
        {e.state === 4 ? "Raise failed before finalization — no liquidity pool was ever created, so there is nothing to lock." : e.state === 1 ? "Raise still collecting — the permanent LP is created at finalization." : "No LP lock read for this escrow."}
      </p>
    );
  }
  if (l.status !== "verified") {
    return (
      <div className="text-[13px]">
        <p className={l.status === "unavailable" ? "text-ink-meta" : "text-crit"}>{l.status === "rescued" ? "LP RESCUED — not permanently locked" : l.status === "not-locked" ? "NOT LOCKED" : "Proof-of-Lock unavailable"}</p>
        <p className="mt-1 text-ink-meta">{l.note}</p>
        {l.routerLpStatusLabel && <p className="mt-1 mono text-[12px] text-ink-meta">router.lpStatus(token) = {l.routerLpStatusLabel}</p>}
      </div>
    );
  }
  const share = l.lockedShareBps ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Fig label="Pool LP soulbound" value={share >= 9999 ? "≈100%" : pct(l.lockedShareBps)} tone="phosphor" sub={l.unlockedShareBps != null ? `max ever removable: ${pct(l.unlockedShareBps)}` : undefined} />
        <Fig label="ETH paired at lock" value={l.ethPaired ? `${fmtUnits(l.ethPaired, 18, 4)} Ξ` : "—"} sub={l.tokensPaired ? `${fmtCompact(l.tokensPaired, e.tokenDecimals ?? 18)} ${e.tokenSymbol ?? ""}` : undefined} />
        <Fig label="Fee claimer" value={l.claimerIsImmutableClone ? "Immutable ✓" : l.claimerIsImmutableClone === false ? "Non-standard" : "—"} tone={l.claimerIsImmutableClone ? "phosphor" : "warn"} sub="EIP-1167 clone · no withdraw path" />
        <Fig label="Locked" value={l.lockedAt ? fmtUtc(l.lockedAt).slice(0, 10) : "—"} sub={l.lockerVersion ? `VibesLPLocker${l.lockerVersion === "v2" ? "V2" : " v1"}` : undefined} />
      </div>
      <div className="relative h-1.5 w-full overflow-hidden bg-white/[0.06]" role="img" aria-label={`Locked share ${pct(l.lockedShareBps)}`} data-rv="bar">
        <span className="bar-fill absolute inset-0 bg-phosphor" style={{ "--v": Math.min(1, share / 10000) } as CSSProperties} />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px] [overflow-wrap:anywhere]">
        <dt className="text-ink-meta">verifyLPLocked()</dt>
        <dd className="text-phosphor">true · {l.lpLocked ? fmtUnits(l.lpLocked, 18, 3) : "—"} of {l.lpTotalSupply ? fmtUnits(l.lpTotalSupply, 18, 3) : "—"} LP</dd>
        {l.locker && (
          <>
            <dt className="text-ink-meta">Locker</dt>
            <dd><AddrLink chainId={l.chainId} address={l.locker} label={`VibesLPLocker${l.lockerVersion === "v2" ? "V2" : " v1"}`} /></dd>
          </>
        )}
        {l.feeClaimer && (
          <>
            <dt className="text-ink-meta">LP holder</dt>
            <dd><AddrLink chainId={l.chainId} address={l.feeClaimer} label="VibesLPFeeClaimer clone" /></dd>
          </>
        )}
        {l.pool && (
          <>
            <dt className="text-ink-meta">Pool</dt>
            <dd><AddrLink chainId={l.chainId} address={l.pool} /></dd>
          </>
        )}
        {l.routerLpStatusLabel && (
          <>
            <dt className="text-ink-meta">Router lpStatus</dt>
            <dd className={l.routerLpStatus === 1 ? "text-phosphor" : "text-warn"}>{l.routerLpStatusLabel}</dd>
          </>
        )}
        {l.lockTx && (
          <>
            <dt className="text-ink-meta">Lock tx</dt>
            <dd className={l.lockTx.verified ? "text-phosphor" : "text-warn"}>
              <TxLink chainId={l.chainId} hash={l.lockTx.hash} label={l.lockTx.verified ? "receipt verified ✓" : "receipt not verified"} />
              <span className="ml-2 text-ink-meta">{l.lockTx.note}</span>
            </dd>
          </>
        )}
      </dl>
      <p className="max-w-[70ch] text-[14px] leading-relaxed text-ink-2">{l.note}</p>
    </div>
  );
}

function GithubBlock({ g, fallbackLogin, nowSec }: { g: GithubVelocity | null; fallbackLogin: string | null; nowSec: number }) {
  if (!g) return <span className="text-ink-meta">{fallbackLogin ? `@${fallbackLogin}` : "no GitHub identity published by Vibestarter"}</span>;
  const link = (
    <a className="hover:text-ink" title={g.note ?? undefined} href={g.profileUrl} target="_blank" rel="noreferrer nofollow">
      {g.login.startsWith("id:") ? `GitHub account #${g.login.slice(3)}` : `@${g.login}`} <span className="text-ink-meta">↗</span>
    </a>
  );
  if (g.status !== "ok") {
    return (
      <span>
        {link} <span className={g.status === "rate-limited" ? "text-warn" : "text-ink-meta"}>· {g.note}</span>
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
          <span className="text-ink-meta"> / {g.pushes30d ?? "—"}</span>
          <span className="block mono text-[11px] text-ink-meta">pushes 7d / 30d</span>
        </span>
        <span>
          <span className="text-ink">{g.commits7d ?? "—"}</span>
          <span className="text-ink-meta"> / {g.commits30d ?? "—"}{g.commitsCapped ? "+" : ""}</span>
          <span className="block mono text-[11px] text-ink-meta">commits 7d / 30d</span>
        </span>
        <span>
          <span className="text-ink">{g.activeDays30d ?? "—"}</span>
          <span className="block mono text-[11px] text-ink-meta">active days 30d</span>
        </span>
      </div>
      {g.reposPushed30d.length > 0 && <div className="mono text-[12px] text-ink-meta">repos: {g.reposPushed30d.slice(0, 4).join(" · ")}</div>}
      <div className="mono text-[12px] text-ink-meta">commits = landed in the top repos this account pushed to · public repos only · fetched {isoAgo(g.fetchedAt, nowSec)}</div>
    </div>
  );
}
