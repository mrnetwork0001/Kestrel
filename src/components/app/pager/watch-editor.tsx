"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import type { RuleConfig, WatchView } from "@/lib/pager/types";
import { Btn, inputCls, Note, RULE_HELP, RULE_LABEL, Switch } from "./pager-ui";
import { errText, usePagerMutations } from "./use-pager";

const MARK_OPTIONS = [48, 24, 12, 6, 3, 1];

function pct(bps: number) {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

function mins(m: number) {
  return m >= 60 && m % 60 === 0 ? `${m / 60}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

function hours(h: number) {
  return h >= 48 && h % 24 === 0 ? `${h / 24}d` : `${h}h`;
}

function Slider({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-3">
        <span className="mono text-[10.5px] uppercase tracking-wider text-ink-3">{label}</span>
        <span className="tnum text-[12px] text-ink">{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5 w-full" />
    </label>
  );
}

/** Threshold controls for one rule. Only number/enum fields from the RuleConfig union are editable. */
function RuleParams({ rule, set }: { rule: RuleConfig; set: (r: RuleConfig) => void }) {
  switch (rule.type) {
    case "lp_liquidity_drop":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Slider label="Page if liquidity drops" value={rule.dropBps} min={500} max={8000} step={100} fmt={pct} onChange={(v) => set({ ...rule, dropBps: v })} />
          <Slider label="vs peak within" value={rule.windowMin} min={10} max={360} step={5} fmt={mins} onChange={(v) => set({ ...rule, windowMin: v })} />
        </div>
      );
    case "price_move":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Slider label="Page if price moves" value={rule.moveBps} min={500} max={9000} step={100} fmt={pct} onChange={(v) => set({ ...rule, moveBps: v })} />
          <Slider label="within" value={rule.windowMin} min={10} max={360} step={5} fmt={mins} onChange={(v) => set({ ...rule, windowMin: v })} />
        </div>
      );
    case "spread_bps":
      return <Slider label="Page if spread exceeds" value={rule.maxBps} min={50} max={2000} step={25} fmt={pct} onChange={(v) => set({ ...rule, maxBps: v })} />;
    case "parity_drift":
      return <Slider label="Warn if locked > circulating for" value={rule.persistMin} min={1} max={120} step={1} fmt={mins} onChange={(v) => set({ ...rule, persistMin: v })} />;
    case "escrow_window_closing":
      return (
        <div>
          <p className="mono text-[10.5px] uppercase tracking-wider text-ink-3">Warn when time left crosses</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {MARK_OPTIONS.map((h) => {
              const on = rule.marksHours.includes(h);
              return (
                <button
                  key={h}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ ...rule, marksHours: on ? rule.marksHours.filter((x) => x !== h) : [...rule.marksHours, h].sort((a, b) => b - a) })}
                  className={cx("rounded-[2px] border px-2 py-0.5 tnum text-[11px] max-[601px]:min-w-[48px]", on ? "border-phosphor/50 bg-phosphor/[0.08] text-phosphor" : "hairline text-ink-3 hover:text-ink")}
                >
                  {h}h
                </button>
              );
            })}
          </div>
        </div>
      );
    case "escrow_unlock_soon":
      return <Slider label="Notify when next unlock is within" value={rule.leadHours} min={6} max={336} step={6} fmt={hours} onChange={(v) => set({ ...rule, leadHours: v })} />;
    case "wallet_new_approval":
      return (
        <div>
          <p className="mono text-[10.5px] uppercase tracking-wider text-ink-3">Bounded approval to a known spender (Uniswap, Aerodrome, Permit2…)</p>
          <div className="mt-1.5 flex gap-1.5">
            {(["warn", "ignore"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={rule.knownSpenders === v}
                onClick={() => set({ ...rule, knownSpenders: v })}
                className={cx("rounded-[2px] border px-2 py-0.5 mono text-[11px] uppercase max-[601px]:flex-1", rule.knownSpenders === v ? "border-phosphor/50 bg-phosphor/[0.08] text-phosphor" : "hairline text-ink-3 hover:text-ink")}
              >
                {v}
              </button>
            ))}
          </div>
          <Note className="mt-1.5">Unlimited approvals, unknown spenders and ApprovalForAll are always CRITICAL.</Note>
        </div>
      );
    case "whale_transfer":
      return <Slider label="Page if one transfer moves" value={rule.minBpsOfSupply} min={10} max={1000} step={10} fmt={(v) => `${pct(v)} of supply`} onChange={(v) => set({ ...rule, minBpsOfSupply: v })} />;
    case "supply_change":
      return <Slider label="Page if totalSupply moves" value={rule.minBps} min={1} max={500} step={1} fmt={(v) => `${(v / 100).toFixed(2)}%`} onChange={(v) => set({ ...rule, minBps: v })} />;
    case "band_change":
      return <Slider label="Re-scan every" value={rule.everyMin} min={15} max={720} step={15} fmt={mins} onChange={(v) => set({ ...rule, everyMin: v })} />;
    default:
      return null;
  }
}

/** Inline editor for one watch: label, per-rule toggles, thresholds. PATCH /api/pager/watches/[id]. */
export function WatchEditor({ watch, mutations, onDone }: { watch: WatchView; mutations: ReturnType<typeof usePagerMutations>; onDone: () => void }) {
  const [label, setLabel] = useState(watch.label);
  const [rules, setRules] = useState<RuleConfig[]>(() => watch.rules.map((r) => ({ ...r }) as RuleConfig));
  const { patchWatch } = mutations;

  const setRule = (i: number, r: RuleConfig) => setRules((rs) => rs.map((x, j) => (j === i ? r : x)));
  const dirty = label !== watch.label || JSON.stringify(rules) !== JSON.stringify(watch.rules);
  const badMarks = rules.some((r) => r.type === "escrow_window_closing" && r.enabled && r.marksHours.length === 0);

  const save = () => {
    patchWatch.mutate(
      { id: watch.id, label: label.trim().slice(0, 80) || watch.label, rules },
      { onSuccess: onDone }
    );
  };

  return (
    <div className="mt-3 space-y-4 border-t hairline pt-4">
      <label className="block">
        <span className="label text-[10px]">Label (plain text, 80 chars)</span>
        <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} className={cx(inputCls, "mt-1.5")} />
      </label>

      {watch.chainId === 8453 && watch.kind === "wallet" && (
        <Note>Approval coverage on Base: VIBES, WETH, USDC + Permit2 (+ extra tokens added at arm time). Robinhood: all tokens and NFTs.</Note>
      )}

      {rules.length === 0 && <Note tone="warn">No rules apply to this target kind.</Note>}

      <ul className="space-y-3">
        {rules.map((r, i) => (
          <li key={r.id} className={cx("border hairline p-3", !r.enabled && "opacity-60")}>
            <div className="flex items-start gap-3">
              <Switch checked={r.enabled} onChange={(v) => setRule(i, { ...r, enabled: v } as RuleConfig)} label={`${RULE_LABEL[r.type]} ${r.enabled ? "on" : "off"}`} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-ink">{RULE_LABEL[r.type] ?? r.type}</p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{RULE_HELP[r.type]}</p>
              </div>
            </div>
            {r.enabled && (
              <div className="mt-3 pl-0 sm:pl-11">
                <RuleParams rule={r} set={(nr) => setRule(i, nr)} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {badMarks && <Note tone="warn">Pick at least one mark for the closing-window rule, or turn it off.</Note>}
      {patchWatch.error && <Note tone="crit">Save failed: {errText(patchWatch.error)}</Note>}
      <div className="flex flex-wrap gap-2">
        <Btn variant="primary" onClick={save} disabled={!dirty || badMarks || patchWatch.isPending}>
          {patchWatch.isPending ? "SAVING…" : "SAVE RULES"}
        </Btn>
        <Btn variant="quiet" onClick={onDone}>
          CANCEL
        </Btn>
      </div>
    </div>
  );
}
