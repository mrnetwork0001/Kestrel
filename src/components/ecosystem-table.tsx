"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Countdown } from "@/components/countdown";
import { ChainDot } from "@/components/editorial";
import { AddrLink, BandBadge, cx, TxLink } from "@/components/ui";
import { fmtUnits } from "@/lib/format";
import type { EcosystemRow } from "@/lib/vibestarter/ecosystem";

/**
 * Sortable Vibestarter Ecosystem Health Board. Desktop (≥ xl): broadsheet table, one row pair per launch (cells + signal line).
 * Below xl: ruled stacks with a sort picker. All external strings (titles, symbols, URLs) render as plain text.
 */

type SortKey = "attention" | "launch" | "xray" | "lock" | "depth" | "escrow" | "next" | "refund" | "app" | "github" | "capsule";
type Dir = "asc" | "desc";

const SORTS: { key: SortKey; label: string; defaultDir: Dir }[] = [
  { key: "attention", label: "Needs attention", defaultDir: "asc" },
  { key: "launch", label: "Launch", defaultDir: "asc" },
  { key: "xray", label: "Token X-Ray", defaultDir: "desc" },
  { key: "lock", label: "Proof-of-Lock", defaultDir: "desc" },
  { key: "depth", label: "Pool depth", defaultDir: "desc" },
  { key: "escrow", label: "Raised", defaultDir: "desc" },
  { key: "next", label: "Next event", defaultDir: "asc" },
  { key: "refund", label: "Refunds unclaimed", defaultDir: "desc" },
  { key: "app", label: "App health", defaultDir: "asc" },
  { key: "github", label: "GitHub velocity", defaultDir: "desc" },
  { key: "capsule", label: "Origin Capsule", defaultDir: "desc" },
];

type SortVal = number | bigint | string | null;

function sortValue(r: EcosystemRow, k: SortKey): SortVal {
  switch (k) {
    case "attention":
      return r.attention;
    case "launch":
      return (r.title ?? r.escrow).toLowerCase();
    case "xray":
      return r.tokenRisk.score;
    case "lock":
      return r.lpLock?.status === "verified" ? r.lpLock.lockedShareBps : r.lpLock ? -1 : null;
    case "depth":
      return r.pool.quoteHeld !== null && r.pool.quoteSymbol === "WETH" ? BigInt(r.pool.quoteHeld) : r.pool.status === "none" ? -1n : null;
    case "escrow":
      return r.escrowState ? BigInt(r.escrowState.totalRaised) : null;
    case "next":
      return r.escrowState?.openWindow?.endsAt ?? r.escrowState?.nextEvent?.at ?? null;
    case "refund":
      return r.refund?.unclaimedEthEstimate ? BigInt(r.refund.unclaimedEthEstimate) : null;
    case "app":
      // healthy first by latency; failing apps sort after healthy ones
      return r.appHealth ? (r.appHealth.ok ? (r.appHealth.latencyMs ?? 99_999) : 1_000_000 + (r.appHealth.status ?? 0)) : null;
    case "github":
      return r.github?.status === "ok" ? (r.github.commits30d ?? r.github.pushes30d ?? 0) : null;
    case "capsule":
      return r.capsule ? (r.capsule.registered ? 2 : 1) : null;
  }
}

function cmp(a: SortVal, b: SortVal): number {
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  const x = a as number | bigint;
  const y = b as number | bigint;
  return x < y ? -1 : x > y ? 1 : 0;
}

const eth = (wei: string | null | undefined, frac = 4) => (wei == null ? "—" : `${fmtUnits(wei, 18, frac)} ETH`);

function Unavail({ children = "unavailable" }: { children?: ReactNode }) {
  return <span className="mono text-[11px] text-ink-meta">{children}</span>;
}

/** Phone/tablet card layout (<=900px): standalone links get a 36px touch target. */
const TAP = "max-[901px]:inline-flex max-[901px]:min-h-9 max-[901px]:items-center max-[901px]:gap-1";

const TONE: Record<string, string> = { critical: "text-crit", warn: "text-warn", info: "text-ink-meta" };

/* ───────────── cells (shared by table + cards) ───────────── */

function LaunchCell({ r }: { r: EcosystemRow }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium text-ink">{r.title ?? "Untitled raise"}</span>
        {r.token?.symbol && <span className="mono text-[11px] text-ink-meta">${r.token.symbol}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <ChainDot chainId={r.chainId} />
        {r.apiStatus && <span className="mono text-[11px] tracking-wider text-ink-meta">{r.apiStatus}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] max-[901px]:gap-x-4 max-[901px]:gap-y-0">
        <AddrLink chainId={r.chainId} address={r.escrow} label="escrow" className={TAP} />
        {r.token && <AddrLink chainId={r.chainId} address={r.token.address} label="token" className={TAP} />}
        {r.vibestarterUrl && (
          <a href={r.vibestarterUrl} target="_blank" rel="noreferrer" className={cx("mono text-ink-2 underline decoration-white/10 underline-offset-2 hover:text-ink", TAP)}>
            raise <span className="text-ink-3">↗</span>
          </a>
        )}
        <a href={`/app?target=${r.escrow}&chain=${r.chainId}&tab=shield`} className={cx("mono text-phosphor underline decoration-phosphor/30 underline-offset-2 hover:decoration-phosphor", TAP)}>
          shield
        </a>
      </div>
    </div>
  );
}

function XrayCell({ r }: { r: EcosystemRow }) {
  const t = r.tokenRisk;
  if (t.status !== "ok" || t.score === null || !t.band) return <Unavail>{t.note.slice(0, 60) || "unavailable"}</Unavail>;
  const top = t.findings.find((f) => f.points > 0);
  return (
    <div title={t.note}>
      <div className="flex items-center gap-2">
        <span className={cx("tnum text-[16px]", t.band === "CRITICAL" ? "text-crit" : t.band === "ELEVATED" ? "text-warn" : "text-phosphor")}>{t.score}</span>
        <BandBadge band={t.band} className="whitespace-nowrap !text-[10px]" />
      </div>
      <p className="mt-1 text-[11px] text-ink-meta">{top ? `${top.title} (+${top.points})` : "No scored findings"}</p>
      {t.degraded && <p className="mono text-[10px] text-warn">partial read</p>}
    </div>
  );
}

function LockCell({ r }: { r: EcosystemRow }) {
  const l = r.lpLock;
  if (!l) {
    const pre = r.escrowState && r.escrowState.state !== 3 && r.escrowState.state !== 7;
    return <Unavail>{pre ? "no LP (raise not funded)" : r.escrowState ? "not read" : "unavailable"}</Unavail>;
  }
  if (l.status === "verified") {
    return (
      <div title={l.note}>
        <span className="whitespace-nowrap tnum text-[16px] text-phosphor">{l.lockedShareBps != null ? `${(l.lockedShareBps / 100).toFixed(2)}%` : "locked"}</span>
        <p className="mt-1 text-[11px] text-ink-meta">
          {l.claimerIsImmutableClone ? "soulbound · immutable claimer" : "held by fee claimer"}
          {l.ethPaired ? ` · ${eth(l.ethPaired, 3)} paired` : ""}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
          {l.feeClaimer && <AddrLink chainId={r.chainId} address={l.feeClaimer} label="claimer" className={TAP} />}
          {l.lockTx?.verified && <TxLink chainId={r.chainId} hash={l.lockTx.hash} label="lock tx" className={TAP} />}
        </div>
      </div>
    );
  }
  return <span className={cx("mono text-[12px]", l.status === "unavailable" ? "text-ink-meta" : "text-crit")} title={l.note}>{l.status === "unavailable" ? "unavailable" : l.status === "rescued" ? "LP rescued — no lock" : "not locked"}</span>;
}

function DepthCell({ r }: { r: EcosystemRow }) {
  const p = r.pool;
  if (p.status === "none") return <Unavail>no WETH pool</Unavail>;
  if (p.status !== "ok" || !p.address) return <Unavail>{p.note.slice(0, 60)}</Unavail>;
  return (
    <div title={p.note}>
      <span className="whitespace-nowrap tnum text-[15px] text-ink">{p.quoteHeld !== null && p.quoteDecimals !== null ? `${fmtUnits(p.quoteHeld, p.quoteDecimals, 3)} ${p.quoteSymbol}` : "depth unscored"}</span>
      <p className="mt-1 text-[11px] text-ink-meta">{p.venue}</p>
      <AddrLink chainId={r.chainId} address={p.address} label="pool" className={cx("text-[11px]", TAP)} />
    </div>
  );
}

function EscrowCell({ r }: { r: EcosystemRow }) {
  const e = r.escrowState;
  if (!e) return <Unavail>{r.escrowError ? `unavailable: ${r.escrowError.slice(0, 50)}` : "unavailable"}</Unavail>;
  const tone = e.state === 3 || e.state === 7 ? "text-phosphor" : e.state === 4 || e.state === 5 || e.state === 6 ? "text-warn" : "text-ink";
  return (
    <div>
      <span className={cx("mono text-[12px] tracking-wider", tone)}>{e.stateLabel.toUpperCase()}</span>
      <p className="mt-1 whitespace-nowrap tnum text-[13px] text-ink-2">{eth(e.totalRaised, 3)} raised</p>
      <p className="mt-0.5 text-[11px] text-ink-meta">
        {e.tranchesPaid}/{e.tranchesTotal} tranches paid · {eth(e.escrowBalance, 3)} held
      </p>
    </div>
  );
}

function NextCell({ r, nowSec }: { r: EcosystemRow; nowSec: number }) {
  const e = r.escrowState;
  if (!e) return <Unavail />;
  if (e.activeChallenge) return <span className="mono text-[12px] text-crit">Challenge pending · Month {e.activeChallenge.tranche}</span>;
  if (e.openWindow)
    return (
      <div>
        <span className="mono text-[12px] text-warn">{e.openWindow.label} window OPEN</span>
        <p className="mt-1 tnum text-[14px] text-warn">
          <Countdown to={e.openWindow.endsAt} initialNow={nowSec} />
        </p>
      </div>
    );
  const n = e.nextEvent;
  const lw = e.lastWindow;
  return (
    <div title={n?.detail}>
      {n ? (
        <>
          <span className="text-[12px] text-ink-2">{n.label}</span>
          {n.at ? (
            <p className="mt-1 tnum text-[14px] text-ink">
              <Countdown to={n.at} initialNow={nowSec} />
            </p>
          ) : (
            <p className="mt-1 mono text-[11px] text-ink-meta">no fixed time</p>
          )}
        </>
      ) : (
        <Unavail>no scheduled event</Unavail>
      )}
      {lw && !lw.open && (
        <p className="mt-1 text-[11px] text-ink-meta">
          Last: {lw.label} window {lw.challenged ? "challenged" : "unchallenged"}
          {lw.claimed ? ", paid" : ""}
        </p>
      )}
    </div>
  );
}

function RefundCell({ r }: { r: EcosystemRow }) {
  const f = r.refund;
  if (!f) return <Unavail>n/a (not refunding)</Unavail>;
  if (f.allClaimed) return <span className="mono text-[12px] text-ink-2" title={f.note}>all claimed</span>;
  return (
    <div title={f.note}>
      <span className="whitespace-nowrap tnum text-[14px] text-warn">{f.unclaimedEthEstimate ? eth(f.unclaimedEthEstimate) : "unknown"}</span>
      <p className="mt-1 text-[11px] text-ink-meta">
        {f.mode} refunds{f.redeemedBps != null ? ` · ${(f.redeemedBps / 100).toFixed(2)}% redeemed` : ""}
      </p>
      {f.sweepAfter && <p className="text-[11px] text-ink-meta">closes {new Date(f.sweepAfter * 1000).toISOString().slice(0, 10)}</p>}
    </div>
  );
}

function AppCell({ r }: { r: EcosystemRow }) {
  const a = r.appHealth;
  if (!r.appUrl) return <Unavail>no app URL listed</Unavail>;
  let host = r.appUrl;
  try {
    host = new URL(r.appUrl).host;
  } catch {
    /* plain text fallback */
  }
  return (
    <div>
      {a ? (
        <span className={cx("whitespace-nowrap mono text-[12px]", a.ok ? "text-phosphor" : "text-crit")}>
          ● {a.status ? `HTTP ${a.status}` : "unreachable"}
          {a.latencyMs != null && <span className="text-ink-meta"> · {a.latencyMs} ms</span>}
        </span>
      ) : (
        <Unavail>not probed</Unavail>
      )}
      <p className="mt-1 truncate text-[11px]">
        <a href={r.appUrl} target="_blank" rel="noreferrer nofollow" className="mono text-ink-meta underline decoration-white/10 underline-offset-2 hover:text-ink max-[901px]:block max-[901px]:truncate max-[901px]:py-2.5">
          {host} ↗
        </a>
      </p>
    </div>
  );
}

function GithubCell({ r }: { r: EcosystemRow }) {
  const g = r.github;
  if (!g) return <Unavail>{r.githubLogin ? "unavailable" : "GitHub login not resolved"}</Unavail>;
  const idLogin = g.login.startsWith("id:") ? g.login.slice(3) : null;
  const link = (
    <a href={g.profileUrl} target="_blank" rel="noreferrer" title={g.note} className={cx("mono text-[11px] text-ink-meta underline decoration-white/10 underline-offset-2 hover:text-ink", TAP)}>
      {idLogin ? `GitHub account #${idLogin}` : `@${g.login}`} ↗
    </a>
  );
  if (g.status !== "ok")
    return (
      <div title={g.note}>
        <Unavail>{g.status === "rate-limited" ? "GitHub rate-limited" : g.status === "not-found" ? "user not found" : "GitHub unavailable"}</Unavail>
        <p className="mt-1">{link}</p>
      </div>
    );
  return (
    <div title={g.note}>
      <span className="whitespace-nowrap tnum text-[14px] text-ink">
        {g.commits30d ?? "—"}
        {g.commitsCapped ? "+" : ""} <span className="text-[11px] text-ink-meta">commits/30d</span>
      </span>
      <p className="mt-0.5 text-[11px] text-ink-meta">
        {g.pushes30d ?? "—"} pushes · {g.activeDays30d ?? "—"} active days
      </p>
      {g.capsuleRepo && (
        <p className={cx("text-[11px]", g.capsuleRepo.status === "ok" ? "text-ink-meta" : "text-warn")}>
          capsule repo {g.capsuleRepo.status === "ok" ? `pushed ${g.capsuleRepo.pushedAt?.slice(0, 10) ?? "—"}` : g.capsuleRepo.status === "not-found" ? "404" : "unreadable"}
        </p>
      )}
      <p className="mt-0.5">{link}</p>
    </div>
  );
}

function CapsuleCell({ r }: { r: EcosystemRow }) {
  const c = r.capsule;
  if (!c) return <Unavail>none found</Unavail>;
  return (
    <div title={c.capsuleHash ?? undefined}>
      <span className={cx("whitespace-nowrap mono text-[12px]", c.registered ? "text-phosphor" : "text-warn")}>{c.registered ? "✓ registered" : "not registered"}</span>
      {(c.provenanceLabel || c.agentName) && (
        <p className="mt-1 text-[11px] text-ink-meta">
          {[c.provenanceLabel, c.agentName].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

function Signals({ r }: { r: EcosystemRow }) {
  if (!r.signals.length) return <span className="mono text-[11px] text-ink-meta">No active warnings from the live reads.</span>;
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1">
      {r.signals.map((s, i) => (
        <li key={i} className={cx("text-[12px]", TONE[s.tone])}>
          <span aria-hidden className="mr-1.5 text-ink-3">·</span>
          {s.text}
        </li>
      ))}
    </ul>
  );
}

/* ───────────── board ───────────── */

const COLS: { key: SortKey; label: string; cell: (r: EcosystemRow, now: number) => ReactNode; w?: string; num?: boolean }[] = [
  { key: "launch", label: "Launch", cell: (r) => <LaunchCell r={r} />, w: "min-w-[170px]" },
  { key: "xray", label: "Token X-Ray", cell: (r) => <XrayCell r={r} />, num: true },
  { key: "lock", label: "Proof-of-Lock", cell: (r) => <LockCell r={r} />, num: true },
  { key: "depth", label: "Pool depth", cell: (r) => <DepthCell r={r} />, num: true },
  { key: "escrow", label: "Escrow", cell: (r) => <EscrowCell r={r} /> },
  { key: "next", label: "Next window", cell: (r, now) => <NextCell r={r} nowSec={now} />, w: "min-w-[135px]" },
  { key: "refund", label: "Refund radar", cell: (r) => <RefundCell r={r} />, num: true },
  { key: "app", label: "App HTTP", cell: (r) => <AppCell r={r} /> },
  { key: "github", label: "Founder GitHub", cell: (r) => <GithubCell r={r} />, num: true },
  { key: "capsule", label: "Origin Capsule", cell: (r) => <CapsuleCell r={r} /> },
];

export function EcosystemTable({ rows, nowSec }: { rows: EcosystemRow[]; nowSec: number }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: "attention", dir: "asc" });

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === null && vb === null) return a.attention - b.attention;
      if (va === null) return 1; // unavailable always last
      if (vb === null) return -1;
      const c = cmp(va, vb);
      return (sort.dir === "asc" ? c : -c) || a.attention - b.attention;
    });
    return out;
  }, [rows, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: SORTS.find((x) => x.key === key)?.defaultDir ?? "desc" }));

  if (!rows.length) return null;

  return (
    <div>
      {/* sort picker (cards) */}
      <div className="mb-3 flex flex-wrap items-center gap-2 xl:hidden max-[601px]:[&>select]:min-w-0 max-[601px]:[&>select]:flex-1">
        <label htmlFor="eco-sort" className="t-kicker">
          Sort by
        </label>
        <select
          id="eco-sort"
          value={sort.key}
          onChange={(e) => {
            const key = e.target.value as SortKey;
            setSort({ key, dir: SORTS.find((x) => x.key === key)?.defaultDir ?? "desc" });
          }}
          className="rounded-[2px] border border-hair-strong bg-surface px-2 py-1.5 mono text-[12px] text-ink max-[901px]:min-h-11 max-[901px]:text-[16px]"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
          className="rounded-[2px] border border-hair-strong px-2 py-1.5 mono text-[12px] text-ink-2 hover:text-ink max-[901px]:min-h-11 max-[901px]:px-3"
          aria-label={`Sort direction: ${sort.dir === "asc" ? "ascending" : "descending"}`}
        >
          {sort.dir === "asc" ? "↑ asc" : "↓ desc"}
        </button>
      </div>

      {/* desktop broadsheet table (>= xl): no outer box, sticky kicker header, hover-elevated row pairs */}
      <div className="hidden xl:block">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Vibestarter launches on Base and Robinhood Chain with live health checks. Click a column header to sort.</caption>
          <thead className="sticky top-0 z-10 bg-canvas/95 backdrop-blur-sm">
            <tr className="border-b border-hair-strong">
              {COLS.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th key={c.key} scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cx("px-2.5 py-3 align-bottom first:pl-3", c.w, c.num && "text-right")}>
                    <button type="button" onClick={() => toggle(c.key)} className={cx("t-kicker inline-flex items-center gap-1 hover:!text-ink", c.num && "flex-row-reverse", active && "!text-phosphor")}>
                      <span>{c.label}</span>
                      <span aria-hidden className={active ? undefined : "opacity-30"}>{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          {sorted.map((r) => (
            <RowPair key={r.key} r={r} nowSec={nowSec} />
          ))}
        </table>
      </div>

      {/* <xl: ruled 2-line stacks (paper, no card boxes) */}
      <ul className="divide-y divide-hair border-y border-hair xl:hidden">
        {sorted.map((r) => (
          <li key={r.key} className="min-w-0 py-5">
            <LaunchCell r={r} />
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-3 max-[601px]:gap-x-3">
              {COLS.slice(1).map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="t-kicker mb-1">{c.label}</dt>
                  <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{c.cell(r, nowSec)}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 border-t border-hair pt-3">
              <Signals r={r} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowPair({ r, nowSec }: { r: EcosystemRow; nowSec: number }) {
  return (
    <tbody className="group border-b border-hair">
      <tr className="align-top transition-colors duration-200 group-hover:bg-elevated">
        {COLS.map((c) => (
          <td key={c.key} className={cx("min-h-11 px-2.5 pb-2 pt-4 first:pl-3", c.w, c.num && "text-right [&_.flex]:justify-end")}>
            {c.cell(r, nowSec)}
          </td>
        ))}
      </tr>
      <tr className="transition-colors duration-200 group-hover:bg-elevated">
        <td colSpan={COLS.length} className="px-3 pb-4">
          <Signals r={r} />
        </td>
      </tr>
    </tbody>
  );
}
