"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ShareCard } from "@/components/share-card";
import { ChainBadge, cx } from "@/components/ui";
import { Kicker, SkeletonRows } from "@/components/editorial";
import { Settle } from "@/components/motion";
import type { ScanResult, ThreatBand } from "@/lib/engine/types";
import { explorerAddress, explorerBlock, fmtUtc, shortAddr } from "@/lib/format";

const BAND_TEXT: Record<ThreatBand, string> = { NOMINAL: "text-phosphor", ELEVATED: "text-warn", CRITICAL: "text-crit" };
const BAND_BG: Record<ThreatBand, string> = { NOMINAL: "bg-phosphor", ELEVATED: "bg-warn", CRITICAL: "bg-crit" };

export type BriefState = "idle" | "loading" | "loaded" | "error";

/** Small text action: underline inks in on hover; ≥44px tap target on mobile. */
const ACTION = "ink-target press inline-flex min-h-8 items-center mono text-[12px] tracking-[0.04em] disabled:pointer-events-none disabled:opacity-50 max-[901px]:min-h-11";

function CopyAddress({ address }: { address: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setDone(true);
          t.current = setTimeout(() => setDone(false), 1400);
        } catch {
          setDone(false);
        }
      }}
      className="press inline-flex min-h-6 items-center text-ink-2 hover:text-phosphor max-[901px]:min-h-11"
      aria-label="Copy address"
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

/**
 * Full-bleed surface band naming what the desk is looking at, with the live verdict on the right.
 * Left: kicker (TARGET · KIND · chain), serif name, meta line (address, block, time, duration, findings).
 * Right: OVERNIGHT THREAT score (Settle, keyed so a new real score settles in once), band word, 240×4 gauge with
 * 30 / 65 threshold ticks, and text actions. States: first-load skeleton, in-flight (previous values at .6 plus an
 * in-flight segment on the bottom rule), error (target stays; RETRY), degraded (warn kicker naming the failed read).
 * Reused by /rescue: every action is optional.
 */
export function TargetMasthead({
  scan,
  target,
  chainId,
  loading,
  error,
  retryAfterSec,
  degraded = [],
  notice,
  onRetry,
  onBrief,
  briefState = "idle",
  share = true,
}: {
  scan: ScanResult | null;
  target: string;
  chainId: number;
  loading: boolean;
  error?: string | null;
  retryAfterSec?: number | null;
  degraded?: string[];
  /** Replaces the verdict column with a plain message (e.g. unsupported chain). */
  notice?: ReactNode;
  onRetry?: () => void;
  onBrief?: () => void;
  briefState?: BriefState;
  share?: boolean;
}) {
  // A scan for a different target must not be shown as this target's verdict.
  const s = scan && scan.target.address.toLowerCase() === target.toLowerCase() && scan.target.chainId === chainId ? scan : null;
  const firstLoad = !s && loading && !error && !notice;
  const stale = !!s && loading;
  const addr = s?.target.address ?? target;
  const cid = s?.target.chainId ?? chainId;
  const name = s ? s.target.label || shortAddr(addr) : shortAddr(addr);
  const kind = s ? s.target.kind.toUpperCase() : loading ? "READING" : "ADDRESS";
  const block = s ? BigInt(s.block.number).toLocaleString("en-US") : null;

  return (
    <section aria-label="Scan target" aria-busy={loading || undefined} className="band relative overflow-hidden border-b border-hair-strong">
      <div className="wrap py-7 max-[901px]:py-5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 min-[901px]:grid-cols-12 min-[901px]:gap-y-3">
          {/* Kicker */}
          <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 min-[901px]:col-span-8">
            <Kicker as="span">
              TARGET · {kind}
            </Kicker>
            <ChainBadge chainId={cid} />
          </div>

          {/* Name */}
          <h1
            key={`${cid}:${addr.toLowerCase()}`}
            className={cx(
              "col-start-1 row-start-2 min-w-0 font-serif text-[28px] leading-[1.05] tracking-[-0.01em] text-ink [overflow-wrap:anywhere] [text-wrap:balance] min-[901px]:col-span-8 min-[901px]:text-[clamp(32px,3.4vw,52px)]",
              "transition-opacity duration-300",
              stale && "opacity-60"
            )}
          >
            <span className="tab-enter inline-block">{name}</span>
          </h1>

          {/* Verdict (desktop: right column, rows 1–2; mobile: inline right of the name) */}
          <div
            className={cx(
              "col-start-2 row-start-2 flex flex-col items-end text-right transition-opacity duration-300 min-[901px]:col-span-4 min-[901px]:col-start-9 min-[901px]:row-span-2 min-[901px]:row-start-1",
              stale && "opacity-60"
            )}
          >
            {notice ? null : error && !stale ? (
              <div className="max-w-[360px] max-[901px]:hidden">
                <p className="t-kicker text-crit">Scan failed</p>
              </div>
            ) : s ? (
              <>
                <p className="t-kicker max-[901px]:hidden">Overnight threat</p>
                <p className={cx("mt-1 flex items-baseline gap-2 leading-none", BAND_TEXT[s.band])}>
                  <Settle key={`${s.score}:${addr}`} value={String(s.score)} className="t-data-xl max-[901px]:!text-[48px]" />
                  <span className="mono text-[15px] text-ink-meta max-[901px]:text-[12px]">/ 100</span>
                </p>
                <p className={cx("t-kicker mt-1", BAND_TEXT[s.band])}>{s.band}</p>
              </>
            ) : firstLoad ? (
              <div className="w-[120px] min-[901px]:w-[240px]" aria-hidden>
                <span className="skel mt-2 ml-auto block h-[48px] w-[64px] rounded-[2px] bg-white/[0.06] min-[901px]:h-[64px] min-[901px]:w-[96px]" />
              </div>
            ) : null}
          </div>

          {/* Meta line / degraded / error detail */}
          <div className="col-span-2 min-w-0 min-[901px]:col-span-8 min-[901px]:row-start-3">
            {firstLoad ? (
              <SkeletonRows rows={1} heights={[28]} caption="Reading Base & Robinhood Chain" className="max-w-[560px] border-y-0" />
            ) : (
              <p className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 mono text-[13px] text-ink-2 transition-opacity duration-300", stale && "opacity-60")}>
                <span className="break-all text-ink max-[901px]:hidden">{addr}</span>
                <span className="text-ink min-[901px]:hidden">{shortAddr(addr)}</span>
                <CopyAddress address={addr} />
                <a href={explorerAddress(cid, addr)} target="_blank" rel="noreferrer" className="press inline-flex min-h-6 items-center hover:text-ink max-[901px]:min-h-11" aria-label="Open address in block explorer">
                  explorer ↗
                </a>
                {s && (
                  <>
                    <span aria-hidden className="text-ink-meta">·</span>
                    <a href={explorerBlock(cid, s.block.number)} target="_blank" rel="noreferrer" className="press tnum hover:text-ink">
                      block #{block} ↗
                    </a>
                    <span aria-hidden className="text-ink-meta">·</span>
                    <span className="tnum">{fmtUtc(s.block.timestamp)}</span>
                    <span aria-hidden className="text-ink-meta">·</span>
                    <span className="tnum">scanned in {s.durationMs.toLocaleString("en-US")} ms</span>
                    <span aria-hidden className="text-ink-meta">·</span>
                    <span className="tnum">
                      {s.findings.length} {s.findings.length === 1 ? "finding" : "findings"}
                    </span>
                  </>
                )}
              </p>
            )}

            {notice && <div className="mt-3 max-w-[720px] mono text-[13px] text-warn">{notice}</div>}

            {error && (
              <div role="alert" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="min-w-0 mono text-[13px] text-crit [overflow-wrap:anywhere]">
                  <span className="min-[901px]:hidden">Scan failed: </span>
                  {stale || s ? "Re-scan failed: " : ""}
                  {error}
                  {retryAfterSec ? ` · retry in ~${retryAfterSec}s` : ""}
                </p>
                {onRetry && (
                  <button type="button" onClick={onRetry} className="btn-outline press !min-h-11 !px-4">
                    RETRY
                  </button>
                )}
              </div>
            )}

            {!error && s && degraded.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1" role="status">
                <Kicker tone="warn" as="span">
                  Incomplete scan · {degraded[0]}
                  {degraded.length > 1 ? ` (+${degraded.length - 1} more)` : ""}
                </Kicker>
                {onRetry && (
                  <button type="button" onClick={onRetry} disabled={loading} className={cx(ACTION, "text-warn")}>
                    <span className="ink-line">Re-scan</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Gauge + actions (desktop: right column, row 3; mobile: full width after the meta line) */}
          {s && !notice && (
            <div className={cx("col-span-2 flex flex-col gap-3 transition-opacity duration-300 min-[901px]:col-span-4 min-[901px]:col-start-9 min-[901px]:row-start-3 min-[901px]:items-end", stale && "opacity-60")}>
              <div className="relative h-1 w-[240px] max-w-full bg-white/[0.08] max-[901px]:w-full" data-rv="bar" role="img" aria-label={`Threat ${s.score} of 100, ${s.band}`}>
                <span
                  className={cx("bar-fill absolute inset-0", BAND_BG[s.band])}
                  style={{ "--v": Math.max(0.02, Math.min(1, s.score / 100)), transitionDuration: "700ms" } as CSSProperties}
                />
                <span aria-hidden className="absolute -inset-y-[3px] left-[30%] w-px bg-white/30" />
                <span aria-hidden className="absolute -inset-y-[3px] left-[65%] w-px bg-white/30" />
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 min-[901px]:justify-end">
                {share && (
                  <details className="group relative">
                    <summary className={cx(ACTION, "text-ink-2 hover:text-ink cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
                      <span className="ink-line">Share card</span>
                    </summary>
                    <div className="panel absolute right-0 top-full z-30 mt-2 w-[min(440px,calc(100vw-32px))] p-4 pt-0 text-left max-[901px]:left-0 max-[901px]:right-auto">
                      <ShareCard address={addr} chainId={cid} label={name} score={s.score} band={s.band} />
                    </div>
                  </details>
                )}
                {onBrief && (
                  <button type="button" onClick={onBrief} disabled={briefState === "loading" || briefState === "loaded"} className={cx(ACTION, "text-ink-2 hover:text-ink")}>
                    <span className="ink-line">
                      {briefState === "loading" ? "Synthesizing AI brief" : briefState === "loaded" ? "AI brief ready" : briefState === "error" ? "AI brief failed · retry" : "Synthesize AI brief"}
                    </span>
                    {briefState === "loading" && <span aria-hidden className="cursor-blink" />}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Bottom rule: in-flight segment while a scan is running. */}
      {loading && <span aria-hidden className="inflight" />}
    </section>
  );
}
