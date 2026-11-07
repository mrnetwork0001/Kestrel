"use client";

import { ChainDot } from "@/components/editorial";
import { cx, SEVERITY_COLOR } from "@/components/ui";
import { fmtDuration } from "@/lib/format";
import type { DigestPayload } from "@/lib/pager/types";
import { Tag } from "./pager-ui";
import { hhmm, safeHref } from "./use-pager";

function fmtCount(v: string | undefined): string {
  if (!v) return "—";
  try {
    return BigInt(v).toLocaleString("en-US");
  } catch {
    return "—";
  }
}

/** Renders a "While You Slept" digest. All strings are plain text; links are filtered to http(s) or same-origin. */
export function DigestView({ digest, compact }: { digest: DigestPayload; compact?: boolean }) {
  const dur = Math.max(0, (digest.endedAt - digest.startedAt) / 1000);
  const base = digest.blocks?.[8453];
  const rh = digest.blocks?.[4663];
  return (
    <div className="space-y-3">
      <p className="mono text-[12px] text-phosphor">
        &gt;_ WHILE YOU SLEPT · {hhmm(digest.startedAt)} → {hhmm(digest.endedAt)}
        {digest.tz ? ` (${digest.tz})` : ""} · {fmtDuration(dur)}
      </p>
      <p className="text-[13px] leading-relaxed text-ink-2">
        Kestrel ran <span className="tnum text-ink">{digest.checks.toLocaleString("en-US")}</span> checks
        {base ? (
          <>
            {" "}across <span className="tnum text-base">{fmtCount(base.count)}</span> Base blocks
          </>
        ) : null}
        {rh ? (
          <>
            {base ? " and " : " across "}
            <span className="tnum text-rh">{fmtCount(rh.count)}</span> Robinhood blocks
          </>
        ) : null}
        . {digest.pagedCount} {digest.policy === "page-all" ? "page" : "critical page"}
        {digest.pagedCount === 1 ? "" : "s"} sent · {digest.deferredCount} warning{digest.deferredCount === 1 ? "" : "s"} held for this digest.
      </p>
      {digest.checks === 0 && <p className="mono text-[12px] text-warn">No sentinel checks ran during this window.</p>}
      {digest.perWatch.length > 0 && (
        <ul className={cx("space-y-2", compact && "space-y-1.5")}>
          {digest.perWatch.map((w) => (
            <li key={w.watchId} className="border-l border-hair-strong pl-3">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className={cx("mono", SEVERITY_COLOR[w.severity])}>{w.severity === "info" ? "○" : "●"}</span>
                <span className="text-ink">{w.label}</span>
                <ChainDot chainId={w.chainId} />
              </div>
              {w.lines.map((l, i) => (
                <p key={i} className="mt-0.5 mono text-[11px] leading-relaxed text-ink-2">
                  {l}
                </p>
              ))}
              {w.actions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-3">
                  {w.actions.map((a, i) => {
                    const h = safeHref(a.href);
                    return h ? (
                      <a key={i} href={h} className="mono text-[11px] text-crit hover:underline">
                        {a.label}
                      </a>
                    ) : null;
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {digest.brief?.text && (
        <div className="border-l-2 border-phosphor/50 pl-3">
          <div className="flex items-center gap-2">
            <p className="t-kicker">Morning desk brief</p>
            <Tag>{digest.brief.source}</Tag>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{digest.brief.text}</p>
        </div>
      )}
    </div>
  );
}
