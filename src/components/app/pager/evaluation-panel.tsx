"use client";

import { ChainBadge, cx, Panel, SEVERITY_COLOR } from "@/components/ui";
import { chainShort, shortAddr } from "@/lib/format";
import { Btn, Note, RULE_LABEL } from "./pager-ui";
import { fmtBlock, toMs, safeHref, type Delivery, type LegacyTestResponse, type WatchTestResponse } from "./use-pager";
import type { RuleType } from "@/lib/pager/types";

export type Evaluation =
  | { kind: "watch"; watchLabel: string; chainId: number; dispatch: boolean; data: WatchTestResponse }
  | { kind: "legacy"; target: string; chainId: number; data: LegacyTestResponse };

function DeliveryLines({ delivered, dispatch }: { delivered: Delivery[]; dispatch: boolean }) {
  if (!delivered?.length) {
    return <Note>{dispatch ? "No delivery channel linked on this desk: message rendered only." : "Dry run: message rendered, nothing sent."}</Note>;
  }
  return (
    <div className="space-y-0.5">
      {delivered.map((d, i) => (
        <Note key={`${d.channel}-${i}`} tone={d.ok ? "phosphor" : "crit"}>
          {d.channel}: {d.ok ? `delivered${d.status ? ` (HTTP ${d.status})` : ""}` : `failed (${d.error ?? `HTTP ${d.status ?? "?"}`})`}
        </Note>
      ))}
    </div>
  );
}

/**
 * 06 · Live evaluation & message. Shows every rule of a watch evaluated against current chain state (dry run via
 * /api/pager/watches/[id]/test) and the exact plain-text message. Without a desk, previews the workspace target via
 * the legacy one-shot /api/pager/test (render only, no destination).
 */
export function EvaluationPanel({
  evaluation,
  pending,
  error,
  hasDesk,
  target,
  chainId,
  onPreview,
}: {
  evaluation: Evaluation | null;
  pending: boolean;
  error: string | null;
  hasDesk: boolean;
  target: string;
  chainId: number;
  onPreview: () => void;
}) {
  return (
    <Panel title="Live evaluation & message" n="06">
      {!evaluation && !pending && (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-2">
            {hasDesk
              ? "Press TEST on a watch to evaluate each of its rules against current Base and Robinhood Chain state, and see the exact message a page would carry."
              : "Preview the pager without a desk: evaluate the current target's rules against live chain state. Nothing is sent."}
          </p>
          {!hasDesk && (
            <Btn variant="ghost" onClick={onPreview} className="w-full sm:w-auto">
              EVALUATE {shortAddr(target)} · {chainShort(chainId)} NOW
            </Btn>
          )}
        </div>
      )}
      {pending && <Note tone="phosphor">Reading live chain state and evaluating rules…</Note>}
      {error && !pending && <Note tone="crit">{error}</Note>}

      {evaluation?.kind === "watch" && !pending && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 mono text-[11px] text-ink-3">
            <span className="text-ink">{evaluation.watchLabel}</span>
            <ChainBadge chainId={evaluation.chainId} />
            <span>evaluated at {fmtBlock(evaluation.data.block)}</span>
            {toMs(evaluation.data.evaluatedAt) !== null && <span>· {new Date(toMs(evaluation.data.evaluatedAt)!).toISOString().slice(11, 19)} UTC</span>}
          </div>
          {evaluation.data.observations.length === 0 ? (
            <Note>No enabled rules on this watch.</Note>
          ) : (
            <ul className="divide-y divide-white/[0.06] border hairline">
              {evaluation.data.observations.map((o) => (
                <li key={o.ruleId} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 mono text-[11.5px] sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <span className={o.fired ? (o.severity ? SEVERITY_COLOR[o.severity] : "text-warn") : "text-phosphor"}>{o.fired ? `● ${o.severity === "critical" ? "CRIT" : "FIRED"}` : "○ CLEAR"}</span>
                  <span className="truncate text-ink-2">{RULE_LABEL[o.type as RuleType] ?? o.type}</span>
                  <span className="col-span-2 text-ink-3 sm:col-span-1 sm:text-right">
                    {o.observed}
                    {o.threshold ? <span className="text-ink-3"> / {o.threshold}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <pre className="max-h-[420px] overflow-auto overscroll-contain whitespace-pre-wrap break-words border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2 max-[601px]:max-h-[320px] max-[601px]:p-3 max-[601px]:text-[11.5px]">{evaluation.data.message?.text ?? ""}</pre>
          <DeliveryLines delivered={evaluation.data.delivered} dispatch={evaluation.dispatch} />
        </div>
      )}

      {evaluation?.kind === "legacy" && !pending && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 mono text-[11px] text-ink-3">
            <span className="text-ink">{shortAddr(evaluation.target)}</span>
            <ChainBadge chainId={evaluation.chainId} />
            <span>preview (no desk)</span>
          </div>
          <ul className="divide-y divide-white/[0.06] border hairline">
            {evaluation.data.triggers.map((t) => (
              <li key={t.rule} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 mono text-[11.5px] sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span className={t.fired ? "text-warn" : "text-phosphor"}>{t.fired ? "● FIRED" : "○ CLEAR"}</span>
                <span className="truncate text-ink-2">{t.rule}</span>
                <span className="col-span-2 text-ink-3 sm:col-span-1 sm:text-right">{t.observed}</span>
              </li>
            ))}
          </ul>
          <pre className="max-h-[420px] overflow-auto overscroll-contain whitespace-pre-wrap break-words border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2 max-[601px]:max-h-[320px] max-[601px]:p-3 max-[601px]:text-[11.5px]">{evaluation.data.message}</pre>
          <DeliveryLines delivered={evaluation.data.delivered} dispatch={false} />
          {safeHref(evaluation.data.deepLink) && (
            <a href={safeHref(evaluation.data.deepLink)!} className={cx("inline-block break-all mono text-[12px] text-crit hover:underline")}>
              Rescue deep link → {evaluation.data.deepLink.replace(/^https?:\/\/[^/]+/, "")}
            </a>
          )}
          <Btn size="sm" variant="quiet" onClick={onPreview}>
            RE-EVALUATE
          </Btn>
        </div>
      )}
    </Panel>
  );
}
