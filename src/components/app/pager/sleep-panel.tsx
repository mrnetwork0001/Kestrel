"use client";

import { useEffect, useState } from "react";
import { cx, Panel } from "@/components/ui";
import { fmtDuration } from "@/lib/format";
import type { DeskPublic, SleepPublic } from "@/lib/pager/types";
import { DigestView } from "./digest-view";
import { Btn, Dot, inputCls, Note, Switch } from "./pager-ui";
import { errText, hhmm, useNow, usePagerMutations, type SleepStopResponse } from "./use-pager";

const MIN_H = 1;
const MAX_H = 16;

/** Next local occurrence of HH:MM (today if still ahead, else tomorrow). */
function nextWake(hm: string, now: number): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now + 60_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 05 · Sleep mode: freeze a snapshot, hold warnings, page only CRITICAL, deliver a "While You Slept" digest at wake time. */
export function SleepPanel({ desk, sleep, watchCount, mutations }: { desk: DeskPublic | null; sleep: SleepPublic | null; watchCount: number; mutations: ReturnType<typeof usePagerMutations> }) {
  const { startSleep, wake } = mutations;
  const now = useNow(1000);
  const [time, setTime] = useState("07:00");
  const [tz, setTz] = useState<string | null>(null);
  const [criticalOnly, setCriticalOnly] = useState(true);
  const [result, setResult] = useState<SleepStopResponse | null>(null);

  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      setTz(null);
    }
  }, []);

  const deskPolicy = desk?.policy.sleepMode ?? null;
  useEffect(() => {
    if (deskPolicy) setCriticalOnly(deskPolicy !== "page-all");
  }, [deskPolicy]);

  const wakeAt = now !== null ? nextWake(time, now) : null;
  const inSec = wakeAt !== null && now !== null ? (wakeAt - now) / 1000 : null;
  const outOfRange = inSec !== null && (inSec < MIN_H * 3600 || inSec > MAX_H * 3600);

  const goToSleep = () => {
    if (wakeAt === null) return;
    setResult(null);
    startSleep.mutate({ wakeAt: new Date(wakeAt).toISOString(), tz: tz ?? undefined, policy: criticalOnly ? "critical-only" : "page-all" });
  };

  const stop = (digest: boolean) => {
    wake.mutate({ digest }, { onSuccess: (r) => setResult(r ?? { digest: null, delivered: [] }) });
  };

  const sleeping = !!sleep;
  const wakeLeft = sleep && now !== null ? Math.max(0, (sleep.wakeAt - now) / 1000) : null;

  return (
    <Panel
      title="Sleep mode"
      n="05"
      right={
        sleeping ? (
          <span className="flex items-center gap-2 mono text-[11px] tracking-wider text-base">
            <Dot tone="base" live />
            SLEEPING
          </span>
        ) : undefined
      }
    >
      {!desk ? (
        <Note>Open a desk first. Sleep mode holds warnings overnight, pages only CRITICAL events, and sends a &quot;While You Slept&quot; digest at your wake time.</Note>
      ) : sleeping && sleep ? (
        <div className="space-y-4">
          <p className="mono text-[12.5px] leading-relaxed text-ink">
            Sleeping since <span className="tnum">{hhmm(sleep.startedAt)}</span> · digest at <span className="tnum text-base">{hhmm(sleep.wakeAt)}</span>
            {wakeLeft !== null && <span className="text-ink-3"> (in {fmtDuration(wakeLeft)})</span>}
          </p>
          <div className="grid grid-cols-3 gap-px border hairline bg-white/[0.06]">
            <Mini label="Held for digest" value={String(sleep.deferredCount)} />
            <Mini label="Woke you" value={String(sleep.pagedCount)} tone={sleep.pagedCount > 0 ? "crit" : undefined} />
            <Mini label="Policy" value={sleep.policy === "critical-only" ? "CRIT ONLY" : "PAGE ALL"} />
          </div>
          {sleep.tz && <Note>Timezone {sleep.tz} (display only; times above are this browser&apos;s local time).</Note>}
          {startSleep.data?.clamped && <Note tone="warn">Wake time was clamped by the server to the allowed 1–16 h window.</Note>}
          {!!startSleep.data?.pendingFirstCheck && (
            <Note tone="warn">
              {startSleep.data.pendingFirstCheck} watch{startSleep.data.pendingFirstCheck === 1 ? " was" : "es were"} not checked yet when you went to sleep; the digest will mark {startSleep.data.pendingFirstCheck === 1 ? "it" : "them"} as pending first check.
            </Note>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Btn variant="primary" onClick={() => stop(true)} disabled={wake.isPending} className="w-full sm:w-auto">
              {wake.isPending && wake.variables?.digest ? "BUILDING DIGEST…" : "I'M AWAKE, SEND DIGEST NOW"}
            </Btn>
            <Btn variant="quiet" onClick={() => stop(false)} disabled={wake.isPending} className="w-full sm:w-auto">
              CANCEL SLEEP
            </Btn>
          </div>
          {wake.error && <Note tone="crit">{errText(wake.error)}</Note>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block sm:w-40">
              <span className="label text-[10px]">Wake me at</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cx(inputCls, "mt-1.5 tnum text-[14px] [color-scheme:dark]")} aria-label="Wake time" />
            </label>
            <div className="min-w-0 flex-1 mono text-[11.5px] text-ink-3">
              <p>
                Timezone <span className="text-ink-2">{tz ?? "unknown"}</span>
              </p>
              <p>
                Digest in <span className={cx("tnum", outOfRange ? "text-warn" : "text-ink-2")}>{inSec !== null ? fmtDuration(inSec) : "—"}</span>
              </p>
            </div>
          </div>
          <label className="flex items-center gap-3 text-[13px] text-ink-2">
            <Switch checked={criticalOnly} onChange={setCriticalOnly} label="Only wake me for CRITICAL" />
            Only wake me for CRITICAL
          </label>
          <Note>{criticalOnly ? "Warnings are held for the morning digest; only CRITICAL alerts page overnight." : "Every alert pages as it happens; the digest still arrives at wake time."}</Note>
          {outOfRange && <Note tone="warn">The server clamps wake time to 1–16 h from now; it will adjust this to the nearest allowed time.</Note>}
          {watchCount === 0 && <Note tone="warn">No watches armed: the digest will only report scheduler coverage.</Note>}
          <Btn variant="primary" onClick={goToSleep} disabled={startSleep.isPending || wakeAt === null} className="w-full py-3 text-[13px]">
            {startSleep.isPending ? "FREEZING SNAPSHOT…" : "GOING TO SLEEP"}
          </Btn>
          {startSleep.error && <Note tone="crit">{errText(startSleep.error)}</Note>}
          <Note>Going to sleep freezes the latest tick state as the baseline (no extra RPC calls). &quot;All quiet&quot; still sends a digest, so silence never looks like a dead sentinel.</Note>
        </div>
      )}

      {result && (
        <div className="mt-5 border-t hairline pt-4">
          {result.digest ? (
            <DigestView digest={result.digest} />
          ) : (
            <Note>{result.note ?? "Sleep cancelled. No digest was built."}</Note>
          )}
          {result.digest && result.note && <Note className="mt-3">{result.note}</Note>}
          {result.digest && result.queued && <Note tone="phosphor" className="mt-3">Digest queued: the next tick delivers it to your linked channels.</Note>}
          {result.delivered?.length > 0 && (
            <div className="mt-3 space-y-0.5">
              {result.delivered.map((d, i) => (
                <Note key={`${d.channel}-${i}`} tone={d.ok ? "phosphor" : "crit"}>
                  {d.channel}: {d.ok ? `delivered${d.status ? ` (HTTP ${d.status})` : ""}` : `failed (${d.error ?? `HTTP ${d.status ?? "?"}`})`}
                </Note>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "crit" }) {
  return (
    <div className="min-w-0 bg-surface px-3 py-2">
      <p className="label truncate text-[10px]">{label}</p>
      <p className={cx("mt-0.5 tnum text-[15px]", tone === "crit" ? "text-crit" : "text-ink")}>{value}</p>
    </div>
  );
}
