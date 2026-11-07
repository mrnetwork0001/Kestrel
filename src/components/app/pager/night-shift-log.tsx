"use client";

import { ChainBadge, cx, Panel } from "@/components/ui";
import { Dot, Note, Tag } from "./pager-ui";
import { ago, errStatus, errText, fmtBlock, toMs, useNow, usePagerStatus, type PagerStatus } from "./use-pager";

function fmtCount(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  try {
    return BigInt(typeof v === "number" ? Math.trunc(v) : v).toLocaleString("en-US");
  } catch {
    return "—";
  }
}

function cadenceText(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "cadence unknown";
  if (sec < 60) return `every ${sec}s`;
  const m = Math.round(sec / 60);
  return `every ${m} min`;
}

function lastAlertText(a: NonNullable<PagerStatus["systemDesk"]>["watches"][number]["lastAlert"], now: number | null): string {
  if (!a) return "no alerts";
  if (typeof a === "string") return a;
  return `${a.title} · ${ago(toMs(a.at), now)}`;
}

/**
 * 01 · Night-Shift Log (public). Proof-of-watch from GET /api/pager/status: when the sentinel last ran, at which
 * blocks, and the head of the hash-chained tick log. Works with no desk and no wallet.
 */
export function NightShiftLog() {
  const q = usePagerStatus();
  const now = useNow(1000);
  const s = q.data;

  const lastAt = toMs(s?.lastTick?.at ?? null);
  const ageSec = lastAt !== null && now !== null ? Math.max(0, (now - lastAt) / 1000) : (s?.lastTick?.ageSec ?? null);
  const cadence = s?.cadenceSec ?? null;
  const stale = ageSec !== null && cadence ? ageSec > cadence * 3 : false;
  const tone = !s ? "muted" : !s.lastTick ? "warn" : stale || s.healthy === false ? "warn" : "phosphor";
  const schedKind = !s?.scheduler ? null : typeof s.scheduler === "string" ? s.scheduler : s.scheduler.kind;
  const windowAlerts = s?.window?.alerts ?? s?.last24h?.alerts;
  const baseBlocks = s?.window ? (s.window.blocks?.["8453"]?.count ?? null) : (s?.last24h?.blocks?.["8453"] ?? null);
  const rhBlocks = s?.window ? (s.window.blocks?.["4663"]?.count ?? null) : (s?.last24h?.blocks?.["4663"] ?? null);
  const stateText = !s ? (q.isLoading ? "CONNECTING" : "UNAVAILABLE") : !s.lastTick ? "NO TICK YET" : stale ? "STALE" : s.healthy === false ? "DEGRADED" : "LIVE";

  return (
    <Panel
      title="Night-shift log · public proof-of-watch"
      n="01"
      right={
        <span className={cx("flex items-center gap-2 mono text-[11px] tracking-wider", tone === "phosphor" ? "text-phosphor" : tone === "warn" ? "text-warn" : "text-ink-3")}>
          <Dot tone={tone} live={stateText === "LIVE"} />
          {stateText}
        </span>
      }
    >
      {q.isLoading && !s && <Note>Reading the sentinel&apos;s tick log…</Note>}
      {q.error && !s && (
        <Note tone="warn">
          Night-shift log unavailable{errStatus(q.error) ? ` (HTTP ${errStatus(q.error)})` : ""}
          {/^HTTP \d+$/.test(errText(q.error)) ? "" : `: ${errText(q.error)}`}. No numbers are shown rather than guessed.
        </Note>
      )}
      {s && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 mono text-[12px]">
            <span className="text-ink">
              {s.lastTick ? (
                <>
                  last check <span className={cx("tnum", stale ? "text-warn" : "text-phosphor")}>{ago(lastAt, now)}</span>
                </>
              ) : (
                <span className="text-warn">No tick recorded yet: the scheduler has not run against this storage.</span>
              )}
              <span className="text-ink-3"> ({cadenceText(cadence)})</span>
            </span>
            {s.lastTick?.durationMs !== undefined && <span className="text-ink-3">pass took <span className="tnum text-ink-2">{fmtCount(s.lastTick.durationMs)} ms</span></span>}
            {schedKind && <Tag tone={schedKind === "opportunistic-only" ? "warn" : "muted"} title={schedKind === "opportunistic-only" ? "No external scheduler has called the tick yet; ticks run when the status endpoint is visited." : undefined}>sched · {schedKind}</Tag>}
            {s.chain && s.chain.checked > 0 && (
              <Tag tone={s.chain.valid ? "phosphor" : "crit"} title={s.chain.algorithm}>
                {s.chain.valid ? `hash chain ok · ${s.chain.checked} links` : `hash chain broken at ${String(s.chain.brokenAt)}`}
              </Tag>
            )}
            {s.storage && <Tag tone={s.storage === "memory" ? "warn" : "muted"}>{s.storage === "memory" ? "dev memory" : s.storage}</Tag>}
          </div>

          <div className="grid grid-cols-2 gap-px border hairline bg-white/[0.06] sm:grid-cols-3 lg:grid-cols-6">
            <Cell label="Base head checked" value={fmtBlock(s.lastTick?.chains?.["8453"]?.block ?? null)} tone="base" />
            <Cell label="RH head checked" value={fmtBlock(s.lastTick?.chains?.["4663"]?.block ?? null)} tone="rh" />
            <Cell label="Checks total" value={fmtCount(s.checks ?? s.window?.ticks ?? s.last24h?.ticks)} />
            <Cell label={s.window ? `Alerts · last ${s.window.ticks} ticks` : "Alerts / 24h"} value={fmtCount(windowAlerts)} tone={windowAlerts ? "warn" : undefined} />
            <Cell label="Watches armed" value={fmtCount(s.lastTick?.watches)} />
            <Cell label="Log head" value={s.lastTick?.hash ? `${s.lastTick.hash.slice(0, 8)}…` : "—"} title={s.lastTick?.hash ?? undefined} />
          </div>

          {(baseBlocks || rhBlocks) && (
            <Note>
              {s.window ? `Last ${s.window.ticks} ticks (${ago(s.window.fromAt, now).replace(" ago", "")} window)` : "Last 24h"}: {fmtCount(baseBlocks)} Base blocks and {fmtCount(rhBlocks)} Robinhood blocks covered. Each tick hashes the previous one (sha256 chain), so the log is tamper-evident.
            </Note>
          )}

          {s.log && s.log.length > 0 && (
            <div>
              <p className="label mb-2">Recent ticks</p>
              <ul className="divide-y divide-white/[0.06] border hairline">
                {s.log.slice(0, 5).map((t) => (
                  <li key={t.tickId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 mono text-[11px]">
                    <Dot tone={t.chains?.[8453]?.ok === false || t.chains?.[4663]?.ok === false ? "warn" : t.alerts > 0 ? "crit" : "phosphor"} />
                    <span className="min-w-0 truncate text-ink-2">
                      <span className="tnum text-ink-3">{ago(t.startedAt, now)}</span> · {fmtBlock(t.chains?.[8453]?.to ?? null)} <span className="text-ink-3">/</span> {fmtBlock(t.chains?.[4663]?.to ?? null)} · {t.evaluated} eval · {t.alerts} alert{t.alerts === 1 ? "" : "s"}
                      <span className="hidden text-ink-3 sm:inline"> · {fmtCount(t.durationMs)} ms · {t.reason}</span>
                    </span>
                    <span className="tnum text-ink-3" title={t.hash}>
                      {t.hash.slice(0, 8)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {s.systemDesk?.watches?.length ? (
            <div>
              <p className="label mb-2">Public $VIBES system desk</p>
              <ul className="divide-y divide-white/[0.06] border hairline">
                {s.systemDesk.watches.map((w, i) => (
                  <li key={`${w.label}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
                    <Dot tone={w.status === "alerting" ? "crit" : w.status === "error" ? "warn" : w.status === "ok" ? "phosphor" : "muted"} />
                    <span className="min-w-0 truncate text-ink">{w.label}</span>
                    <ChainBadge chainId={w.chainId} />
                    <span className="ml-auto mono text-[11px] text-ink-3">{lastAlertText(w.lastAlert, now)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function Cell({ label, value, tone, title }: { label: string; value: string; tone?: "base" | "rh" | "warn"; title?: string }) {
  const c = tone === "base" ? "text-base" : tone === "rh" ? "text-rh" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="min-w-0 bg-surface px-3 py-2.5" title={title}>
      <p className="label truncate text-[10px]">{label}</p>
      <p className={cx("mt-1 truncate tnum text-[15px]", c)}>{value}</p>
    </div>
  );
}
