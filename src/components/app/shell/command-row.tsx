"use client";

import type { CSSProperties, FormEvent } from "react";
import { LIVE_DEMO_PRESETS } from "@/config/contracts";
import { cx } from "@/components/ui";

export type Preset = (typeof LIVE_DEMO_PRESETS)[number];

const CHAINS = [
  { id: 8453, label: "BASE", n: "8453" },
  { id: 4663, label: "ROBINHOOD", n: "4663" },
] as const;

/**
 * The desk's one input instrument: chain segment · `>_` address input · outline RUN SCAN, 48px tall (.panel chrome).
 * Below it, "Live targets:" and the presets as dot-text links (no pills). Each preset is a real <a href> so it
 * works with JavaScript off; with JS, onClick loads it in place.
 */
export function CommandRow({
  input,
  inputChain,
  inputError,
  scanning,
  target,
  chainId,
  onInput,
  onInputChain,
  onSubmit,
  onPreset,
}: {
  input: string;
  inputChain: number;
  inputError: string | null;
  scanning: boolean;
  target: string;
  chainId: number;
  onInput: (v: string) => void;
  onInputChain: (c: number) => void;
  onSubmit: (e: FormEvent) => void;
  onPreset: (p: Preset) => void;
}) {
  return (
    <div>
      {/* No-JS: a plain GET to /app works (target + chain are the form's field names). */}
      <form
        action="/app"
        method="get"
        onSubmit={onSubmit}
        className="panel relative flex min-h-12 items-stretch overflow-hidden max-[901px]:flex-col max-[901px]:gap-2 max-[901px]:p-2"
      >
        <div role="radiogroup" aria-label="Chain" className="relative flex shrink-0 border-r border-hair mono text-[11px] tracking-[0.12em] max-[901px]:grid max-[901px]:grid-cols-2 max-[901px]:border max-[901px]:rounded-[2px]">
          {CHAINS.map((c) => {
            const on = inputChain === c.id;
            const tone = c.id === 4663 ? "text-rh" : "text-base";
            return (
              <label
                key={c.id}
                className={cx(
                  "press relative flex cursor-pointer items-center gap-2 px-4 has-[input:focus-visible]:bg-white/[0.06] has-[input:focus-visible]:outline has-[input:focus-visible]:outline-1 has-[input:focus-visible]:-outline-offset-1 has-[input:focus-visible]:outline-phosphor/60 max-[901px]:min-h-11 max-[901px]:justify-center",
                  on ? cx(tone, "bg-white/[0.04]") : "text-ink-2 hover:text-ink"
                )}
              >
                <input type="radio" name="chain" value={c.id} checked={on} onChange={() => onInputChain(c.id)} className="sr-only" />
                <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", on ? "bg-current" : "bg-ink-meta/60")} />
                {c.label}
                <span className={cx("tnum", on ? "opacity-70" : "text-ink-meta")}>{c.n}</span>
                {/* Active segment: a 2px underline in the chain colour, drawn in. */}
                <span aria-hidden className={cx("absolute inset-x-0 bottom-0 h-[2px] origin-left bg-current transition-transform duration-300 ease-[var(--ease-rule)]", on ? "scale-x-100" : "scale-x-0")} />
              </label>
            );
          })}
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-3 px-4 max-[901px]:px-2">
          <span aria-hidden className="mono text-[13px] text-phosphor">&gt;_</span>
          <input
            name="target"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            placeholder="Paste any 0x address"
            spellCheck={false}
            autoComplete="off"
            className="w-full min-w-0 bg-transparent py-3 mono text-[14px] text-ink placeholder:text-ink-meta focus:outline-none max-[901px]:text-[16px]"
            aria-label="Target address: wallet, token, pool or Vibestarter escrow"
            aria-invalid={inputError ? true : undefined}
            aria-describedby={inputError ? "cmd-error" : undefined}
          />
        </label>
        <button
          type="submit"
          className="btn-outline press m-1.5 !min-h-0 shrink-0 px-6 max-[901px]:m-0 max-[901px]:!min-h-11"
          aria-busy={scanning || undefined}
        >
          {scanning ? "SCANNING" : "RUN SCAN"}
          {scanning && <span aria-hidden className="cursor-blink" />}
        </button>
        {scanning && <span aria-hidden className="inflight" />}
      </form>
      {inputError && (
        <p id="cmd-error" role="alert" className="mt-2 mono text-[12px] text-crit">
          {inputError}
        </p>
      )}

      {/* Presets: wrap on desktop; ≤600px one horizontally scrolling line whose right edge fades. */}
      <div className="mt-2 flex items-center gap-x-6 gap-y-1 max-[901px]:mt-3 min-[601px]:flex-wrap max-[601px]:-mr-2.5 max-[601px]:overflow-x-auto max-[601px]:pr-8 max-[601px]:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] max-[601px]:[scrollbar-width:none] max-[601px]:[&::-webkit-scrollbar]:hidden">
        <span className="t-meta shrink-0 whitespace-nowrap">Live targets:</span>
        {LIVE_DEMO_PRESETS.map((p, i) => {
          const active = p.targetAddress.toLowerCase() === target.toLowerCase() && p.chainId === chainId;
          const tab = p.kind === "escrow" ? "shield" : p.kind === "pool" ? "chaos" : "briefing";
          return (
            <a
              key={p.id}
              href={`/app?target=${p.targetAddress}&chain=${p.chainId}&tab=${tab}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onPreset(p);
              }}
              aria-current={active ? "true" : undefined}
              data-rv="up"
              style={{ "--i": i } as CSSProperties}
              className={cx("dot-link group relative inline-flex min-h-8 shrink-0 items-center gap-2 whitespace-nowrap text-[13px] max-[901px]:min-h-11", active && "!text-ink")}
            >
              <span aria-hidden className={cx("dot h-1.5 w-1.5 rounded-full", p.chainId === 4663 ? "bg-rh" : "bg-base")} />
              <span className="relative">
                {p.label}
                <span aria-hidden className={cx("absolute inset-x-0 -bottom-0.5 h-px origin-left bg-current transition-transform duration-300 ease-[var(--ease-rule)]", active ? "scale-x-100" : "scale-x-0")} />
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
