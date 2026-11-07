"use client";

import { ChainDot } from "@/components/editorial";
import { cx, SEVERITY_COLOR } from "@/components/ui";
import type { DigestPayload, PagerAlert } from "@/lib/pager/types";
import { DigestView } from "./digest-view";
import { Tag, Note, Section } from "./pager-ui";
import { ago, fmtBlock, safeHref, useNow, type DeskResponse } from "./use-pager";

function isDigest(x: DeskResponse["recentAlerts"][number]): x is DigestPayload & { kind?: "digest" } {
  return !!x && typeof x === "object" && "perWatch" in x && Array.isArray((x as DigestPayload).perWatch);
}

function isAlert(x: DeskResponse["recentAlerts"][number]): x is PagerAlert {
  return !!x && typeof x === "object" && "title" in x && "severity" in x;
}

/** 07 · Recent pages for this desk: alerts and morning digests, newest first. Plain text only. */
export function RecentPages({ hasDesk, items }: { hasDesk: boolean; items: DeskResponse["recentAlerts"] }) {
  const now = useNow(5000);
  const when = (x: DeskResponse["recentAlerts"][number]) => (isDigest(x) ? x.endedAt : isAlert(x) ? x.at : 0);
  const sorted = [...items].sort((a, b) => when(b) - when(a));
  return (
    <Section title="Recent pages" right={hasDesk && items.length ? <span className="tnum mono text-[12px] text-ink-meta">{items.length}</span> : undefined}>
      {!hasDesk ? (
        <Note>Alerts and morning digests for your desk appear here. Every alert carries its block number and explorer evidence.</Note>
      ) : items.length === 0 ? (
        <Note>No pages yet. All quiet on every armed watch.</Note>
      ) : (
        <ul className="divide-y divide-hair border-y border-hair">
          {sorted.slice(0, 20).map((it, i) => {
            if (isDigest(it)) {
              return (
                <li key={`d-${it.endedAt}-${i}`} className="py-4">
                  <DigestView digest={it} compact />
                </li>
              );
            }
            if (!isAlert(it)) return null;
            const a = it;
            return (
              <li key={a.id ?? i} className="py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx("mono text-[12px] uppercase tracking-wider", a.severity === "info" ? "text-ink-meta" : SEVERITY_COLOR[a.severity])}>{a.severity === "critical" ? "CRIT" : a.severity}</span>
                  <ChainDot chainId={a.chainId} />
                  {a.deferred && <Tag>held</Tag>}
                  {a.resolves && <Tag tone="phosphor">resolved</Tag>}
                  <span className="ml-auto mono text-[12px] text-ink-meta">
                    {ago(a.at, now)} · {fmtBlock(a.block)}
                  </span>
                </div>
                <p className="mt-1.5 text-[14px] text-ink">{a.title}</p>
                {a.lines?.map((l, j) => (
                  <p key={j} className="mt-0.5 mono text-[11px] leading-relaxed text-ink-2">
                    {l}
                  </p>
                ))}
                {(a.evidence?.length || a.actions?.length) ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {a.evidence?.map((e, j) => {
                      const h = safeHref(e.href);
                      return h ? (
                        <a key={`e${j}`} href={h} target="_blank" rel="noopener noreferrer" className="mono text-[11px] text-ink-2 underline decoration-white/10 underline-offset-2 hover:text-ink">
                          {e.label} ↗
                        </a>
                      ) : null;
                    })}
                    {a.actions?.map((x, j) => {
                      const h = safeHref(x.href);
                      return h ? (
                        <a key={`a${j}`} href={h} className="mono text-[11px] text-crit hover:underline">
                          {x.label}
                        </a>
                      ) : null;
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
