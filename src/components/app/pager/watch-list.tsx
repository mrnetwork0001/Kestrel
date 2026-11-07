"use client";

import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { AddrLink, ChainBadge, cx, SEVERITY_COLOR } from "@/components/ui";
import { chainShort, shortAddr } from "@/lib/format";
import type { WatchView } from "@/lib/pager/types";
import { Tag, Btn, Dot, type DotTone, inputCls, Instrument, Note, RULE_CHIP, Switch } from "./pager-ui";
import { WatchEditor } from "./watch-editor";
import { ago, errStatus, errText, fmtBlock, hhmm, useNow, usePagerMutations } from "./use-pager";

const STATUS_TONE: Record<WatchView["status"], DotTone> = { ok: "phosphor", alerting: "crit", error: "warn", pending: "muted" };
const STATUS_TEXT: Record<WatchView["status"], string> = { ok: "watching", alerting: "alerting", error: "error", pending: "pending" };

const VIBES_BRIDGE: { address: string; chainId: number; label: string }[] = [
  { address: CONTRACTS.base.vibesBridgeAdapter, chainId: 8453, label: "$VIBES OFT adapter (Base, locked supply)" },
  { address: CONTRACTS.robinhood.vibesReserveAdapter, chainId: 4663, label: "$VIBES OFT reserve adapter (Robinhood)" },
];

function armErrorText(e: unknown): string {
  const s = errStatus(e);
  if (s === 409) return "Already watching this target on this desk.";
  if (s === 429) return `Limit reached: ${errText(e)}`;
  if (s === 503) return `Pager capacity or storage unavailable: ${errText(e)}`;
  return errText(e);
}

/** 03 · Watches: arm the workspace target (or any address), live per-watch status, rule chips, edit/test/delete. */
export function WatchList({
  hasDesk,
  watches,
  maxWatches,
  target,
  chainId,
  mutations,
  onTest,
  testingId,
}: {
  hasDesk: boolean;
  watches: WatchView[];
  maxWatches: number | null;
  target: string;
  chainId: number;
  mutations: ReturnType<typeof usePagerMutations>;
  onTest: (w: WatchView, dispatch: boolean) => void;
  testingId: string | null;
}) {
  const { createWatch } = mutations;
  const [addr, setAddr] = useState(target);
  const [cid, setCid] = useState(chainId);
  const [label, setLabel] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState<string | null>(null);
  const [bridgeErr, setBridgeErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const now = useNow(1000);

  // Follow the workspace target until the user opens the custom form.
  useEffect(() => {
    if (!formOpen) {
      setAddr(target);
      setCid(chainId);
    }
  }, [target, chainId, formOpen]);

  const watching = (a: string, c: number) => watches.some((w) => w.target.toLowerCase() === a.toLowerCase() && w.chainId === c);
  const full = maxWatches !== null && watches.length >= maxWatches;
  const targetValid = isAddress(target, { strict: false });
  const currentWatched = targetValid && watching(target, chainId);

  const arm = (address: string, c: number, l?: string) => {
    setFormErr(null);
    createWatch.mutate(
      { address, chainId: c, label: l?.trim() ? l.trim().slice(0, 80) : undefined },
      {
        onSuccess: () => {
          setLabel("");
          setFormOpen(false);
        },
      }
    );
  };

  const submitForm = () => {
    const a = addr.trim();
    if (!isAddress(a, { strict: false })) {
      setFormErr("Enter a valid 0x address (40 hex characters).");
      return;
    }
    if (watching(a, cid)) {
      setFormErr("Already watching this target on this desk.");
      return;
    }
    arm(a, cid, label);
  };

  const followBridge = async () => {
    setBridgeErr(null);
    for (const b of VIBES_BRIDGE) {
      if (watching(b.address, b.chainId)) continue;
      setBridgeBusy(b.label);
      try {
        await createWatch.mutateAsync({ address: b.address, chainId: b.chainId, label: b.label });
      } catch (e) {
        if (errStatus(e) !== 409) {
          setBridgeErr(`${b.label}: ${armErrorText(e)}`);
          break;
        }
      }
    }
    setBridgeBusy(null);
  };

  const bridgeWatched = VIBES_BRIDGE.every((b) => watching(b.address, b.chainId));
  const arming = createWatch.isPending;

  return (
    <Instrument
      title="Watches"
      right={hasDesk && maxWatches !== null ? <span className="tnum text-[11px] text-ink-meta">{watches.length} / {maxWatches}</span> : undefined}
    >
      {!hasDesk ? (
        <div className="space-y-2">
          <p className="text-[13px] text-ink-2">
            Open a desk to arm watches. Current workspace target: <span className="mono text-ink">{shortAddr(target)}</span> on {chainShort(chainId)}.
          </p>
          <Note>Each watch reads live mainnet state every tick: approvals, LP liquidity, price, proxy implementation, admin keys, OFT peers and parity, and Vibestarter escrow challenge windows.</Note>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Btn variant="primary" onClick={() => arm(target, chainId)} disabled={!targetValid || currentWatched || full || arming} className="w-full sm:w-auto">
              {arming && !bridgeBusy ? "ARMING… READING LIVE STATE" : currentWatched ? `WATCHING ${shortAddr(target)} · ${chainShort(chainId)}` : `+ WATCH CURRENT TARGET (${shortAddr(target)} · ${chainShort(chainId)})`}
            </Btn>
            <Btn variant="ghost" onClick={followBridge} disabled={bridgeWatched || full || arming} className="w-full sm:w-auto">
              {bridgeBusy ? "ARMING BRIDGE…" : bridgeWatched ? "FOLLOWING $VIBES BRIDGE" : "FOLLOW THE $VIBES BRIDGE"}
            </Btn>
            <Btn variant="quiet" onClick={() => setFormOpen((v) => !v)} className="w-full sm:w-auto">
              {formOpen ? "CLOSE" : "OTHER ADDRESS"}
            </Btn>
          </div>
          {arming && <Note tone="phosphor">Arming reads live state (classification, baselines, proxy slots, approvals). This takes 3–15 s.{bridgeBusy ? ` Now: ${bridgeBusy}.` : ""}</Note>}
          {createWatch.error && !bridgeErr && <Note tone="crit">{armErrorText(createWatch.error)}</Note>}
          {bridgeErr && <Note tone="crit">{bridgeErr}</Note>}
          {full && <Note tone="warn">This desk is at its {maxWatches}-watch limit. Delete a watch to arm another.</Note>}

          {formOpen && (
            <div className="space-y-2 border-t border-hair pt-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="flex shrink-0 overflow-hidden rounded-[2px] border hairline mono text-[11px]">
                  {[8453, 4663].map((c) => (
                    <button key={c} type="button" onClick={() => setCid(c)} className={cx("flex-1 px-3 py-2 tracking-wider", cid === c ? (c === 4663 ? "bg-rh/15 text-rh" : "bg-base/15 text-base") : "text-ink-meta hover:text-ink")}>
                      {c === 4663 ? "RH 4663" : "BASE 8453"}
                    </button>
                  ))}
                </div>
                <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x… wallet, token, pool or escrow" spellCheck={false} aria-label="Address to watch" className={inputCls} />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional, plain text)" aria-label="Watch label" className={inputCls} />
                <Btn variant="primary" onClick={submitForm} disabled={arming || full} className="shrink-0">
                  {arming ? "ARMING…" : "ARM WATCH"}
                </Btn>
              </div>
              {formErr && <Note tone="crit">{formErr}</Note>}
            </div>
          )}

          {watches.length === 0 ? (
            <Note>No watches yet. Arm the current target or follow the $VIBES bridge to start the night shift.</Note>
          ) : (
            <ul className="divide-y divide-hair border-y border-hair">
              {watches.map((w) => (
                <WatchRow
                  key={w.id}
                  w={w}
                  now={now}
                  mutations={mutations}
                  editing={editing === w.id}
                  setEditing={(v) => setEditing(v ? w.id : null)}
                  onTest={onTest}
                  testing={testingId === w.id}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Instrument>
  );
}

function WatchRow({
  w,
  now,
  mutations,
  editing,
  setEditing,
  onTest,
  testing,
}: {
  w: WatchView;
  now: number | null;
  mutations: ReturnType<typeof usePagerMutations>;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onTest: (w: WatchView, dispatch: boolean) => void;
  testing: boolean;
}) {
  const { patchWatch, deleteWatch } = mutations;
  const [confirmDel, setConfirmDel] = useState(false);
  const enabledRules = w.rules.filter((r) => r.enabled);
  const status = w.enabled ? w.status : "pending";
  const metrics = Object.entries(w.state.metrics ?? {});
  const toggling = patchWatch.isPending && patchWatch.variables?.id === w.id && patchWatch.variables.enabled !== undefined;
  const deleting = deleteWatch.isPending && deleteWatch.variables === w.id;

  return (
    <li className={cx("px-3 py-3", !w.enabled && "opacity-70")}>
      <div className="flex items-start gap-3">
        <Dot tone={w.enabled ? STATUS_TONE[status] : "muted"} live={w.enabled && status === "alerting"} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-[13.5px] text-ink">{w.label}</span>
            <ChainBadge chainId={w.chainId} />
            <Tag>{w.kind}</Tag>
            <Tag tone={!w.enabled ? "muted" : STATUS_TONE[status]}>{w.enabled ? STATUS_TEXT[status] : "paused"}</Tag>
          </div>
          <div className="mt-1 text-[11.5px]">
            <AddrLink chainId={w.chainId} address={w.target} n={6} />
          </div>

          {enabledRules.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {enabledRules.map((r) => (
                <Tag key={r.id} tone="base" className="text-[9.5px]">
                  {RULE_CHIP[r.type] ?? r.type}
                </Tag>
              ))}
            </div>
          ) : (
            <Note tone="warn" className="mt-2">All rules off: this watch checks state but never pages.</Note>
          )}

          <div className="mt-2 space-y-0.5 mono text-[11px] text-ink-meta">
            <p>
              {w.state.lastCheckedAt ? (
                <>
                  checked <span className="tnum text-ink-2">{ago(w.state.lastCheckedAt, now)}</span> · <span className="tnum text-ink-2">{fmtBlock(w.state.lastCheckedBlock)}</span>
                </>
              ) : (
                "pending first check (next tick)"
              )}
              {w.state.alertCount > 0 && <span> · {w.state.alertCount} alert{w.state.alertCount === 1 ? "" : "s"} total</span>}
            </p>
            {w.state.lastAlert && (
              <p className={cx("truncate", SEVERITY_COLOR[w.state.lastAlert.severity])} title={w.state.lastAlert.title}>
                last alert {hhmm(w.state.lastAlert.at)} · {w.state.lastAlert.title}
              </p>
            )}
            {w.state.lastError && <p className="break-words text-crit">error: {w.state.lastError}</p>}
          </div>

          {metrics.length > 0 && (
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {metrics.map(([k, v]) => (
                <div key={k} className="flex min-w-0 justify-between gap-2 mono text-[11px]">
                  <dt className="truncate text-ink-meta">{k}</dt>
                  <dd className="truncate tnum text-ink-2" title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Switch checked={w.enabled} disabled={toggling} onChange={(v) => patchWatch.mutate({ id: w.id, enabled: v })} label={w.enabled ? "Pause watch" : "Resume watch"} className="mr-1" />
            <Btn size="sm" variant="quiet" onClick={() => onTest(w, false)} disabled={testing}>
              {testing ? "EVALUATING…" : "TEST"}
            </Btn>
            <Btn size="sm" variant="quiet" onClick={() => onTest(w, true)} disabled={testing} title="Evaluate against live state and send the message to this desk's channels">
              TEST + SEND
            </Btn>
            <Btn size="sm" variant="quiet" onClick={() => setEditing(!editing)}>
              {editing ? "CLOSE" : "EDIT"}
            </Btn>
            {confirmDel ? (
              <>
                <Btn size="sm" variant="danger" onClick={() => deleteWatch.mutate(w.id)} disabled={deleting}>
                  {deleting ? "DELETING…" : "CONFIRM DELETE"}
                </Btn>
                <Btn size="sm" variant="quiet" onClick={() => setConfirmDel(false)}>
                  CANCEL
                </Btn>
              </>
            ) : (
              <Btn size="sm" variant="danger" onClick={() => setConfirmDel(true)}>
                DELETE
              </Btn>
            )}
          </div>
          {deleteWatch.error && deleteWatch.variables === w.id && <Note tone="crit" className="mt-1">Delete failed: {errText(deleteWatch.error)}</Note>}
          {patchWatch.error && patchWatch.variables?.id === w.id && !editing && <Note tone="crit" className="mt-1">Update failed: {errText(patchWatch.error)}</Note>}

          {editing && <WatchEditor watch={w} mutations={mutations} onDone={() => setEditing(false)} />}
        </div>
      </div>
    </li>
  );
}
