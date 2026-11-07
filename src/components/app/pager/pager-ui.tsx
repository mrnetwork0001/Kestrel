"use client";

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/components/ui";
import type { RuleType } from "@/lib/pager/types";
import { copyText } from "./use-pager";

type Variant = "primary" | "ghost" | "danger" | "quiet";

const VARIANT: Record<Variant, string> = {
  primary: "bg-phosphor font-semibold text-canvas hover:bg-[#a6e698] border border-phosphor",
  ghost: "border border-hair-strong text-ink hover:border-phosphor/60",
  danger: "border border-crit/40 text-crit hover:border-crit hover:bg-crit/[0.06]",
  quiet: "border hairline text-ink-2 hover:border-hair-strong hover:text-ink",
};

export function Btn({ variant = "ghost", size = "md", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[2px] mono tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "px-2 py-1 text-[10.5px]" : "px-3.5 py-2 text-[12px]",
        // <=900px: every button is >=36px (globals.css); primary actions get the 44px touch target.
        variant === "primary" && "max-[900px]:min-h-[44px]",
        VARIANT[variant],
        className
      )}
    />
  );
}

export function CopyButton({ text, label = "COPY", copiedLabel = "COPIED", size = "sm", variant = "quiet", className }: { text: string; label?: string; copiedLabel?: string; size?: "sm" | "md"; variant?: Variant; className?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <Btn
      size={size}
      variant={variant}
      className={className}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "ok" ? copiedLabel : state === "fail" ? "COPY FAILED" : label}
    </Btn>
  );
}

export type DotTone = "phosphor" | "warn" | "crit" | "muted" | "base";

const DOT: Record<DotTone, string> = {
  phosphor: "bg-phosphor",
  warn: "bg-warn",
  crit: "bg-crit",
  muted: "bg-ink-3",
  base: "bg-base",
};

export function Dot({ tone, live, className }: { tone: DotTone; live?: boolean; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone], live && "dot-live", className)} />;
}

const TAG_TONE: Record<DotTone, string> = {
  phosphor: "border-phosphor/30 text-phosphor",
  warn: "border-warn/40 text-warn",
  crit: "border-crit/40 text-crit",
  muted: "border-hair-strong text-ink-3",
  base: "border-base/30 text-base",
};

export function Tag({ tone = "muted", children, className, title }: { tone?: DotTone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-[2px] border px-1.5 py-0.5 mono text-[10px] uppercase tracking-wider", TAG_TONE[tone], className)}>
      {children}
    </span>
  );
}

/** Accessible on/off switch drawn with hairlines (no native checkbox chrome). */
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-[2px] border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        "max-[900px]:h-[24px] max-[900px]:min-h-0 max-[900px]:w-[42px] max-[900px]:before:absolute max-[900px]:before:-inset-x-1.5 max-[900px]:before:-inset-y-2.5 max-[900px]:before:content-['']",
        checked ? "border-phosphor/60 bg-phosphor/[0.12]" : "border-hair-strong bg-canvas",
        className
      )}
    >
      <span className={cx("absolute top-[3px] h-[10px] w-[10px] rounded-[1px] transition-all max-[900px]:top-[5px] max-[900px]:h-[12px] max-[900px]:w-[12px]", checked ? "left-[18px] bg-phosphor max-[900px]:left-[24px]" : "left-[3px] bg-ink-3 max-[900px]:left-[4px]")} />
    </button>
  );
}

export const inputCls =
  "w-full min-w-0 rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[12px] text-ink placeholder:text-ink-3 focus:border-phosphor/50 focus:outline-none disabled:opacity-50 max-[900px]:min-h-[44px] max-[900px]:text-[16px]";

export function Note({ tone = "muted", children, className }: { tone?: "muted" | "warn" | "crit" | "phosphor"; children: ReactNode; className?: string }) {
  const c = { muted: "text-ink-3", warn: "text-warn", crit: "text-crit", phosphor: "text-phosphor" }[tone];
  return <p className={cx("mono text-[11px] leading-relaxed", c, className)}>{children}</p>;
}

export const RULE_LABEL: Record<RuleType, string> = {
  lp_liquidity_drop: "LP liquidity drop",
  price_move: "Price move",
  spread_bps: "Base ↔ RH spread",
  parity_drift: "OFT parity drift",
  escrow_window_opened: "Challenge window opened",
  escrow_window_closing: "Challenge window closing",
  escrow_unlock_soon: "Tranche unlock soon",
  escrow_challenge_or_state: "Challenge / escrow state",
  wallet_new_approval: "New approval",
  wallet_activity: "Outgoing activity",
  proxy_upgrade: "Proxy upgrade",
  admin_change: "Admin / owner change",
  bridge_peer_change: "OFT peer change",
  whale_transfer: "Whale transfer",
  supply_change: "Supply change",
  band_change: "Threat band change",
};

export const RULE_CHIP: Record<RuleType, string> = {
  lp_liquidity_drop: "LP",
  price_move: "PRICE",
  spread_bps: "SPREAD",
  parity_drift: "PARITY",
  escrow_window_opened: "WINDOW",
  escrow_window_closing: "CLOSING",
  escrow_unlock_soon: "UNLOCK",
  escrow_challenge_or_state: "CHALLENGE",
  wallet_new_approval: "APPROVALS",
  wallet_activity: "ACTIVITY",
  proxy_upgrade: "UPGRADE",
  admin_change: "ADMIN",
  bridge_peer_change: "PEER",
  whale_transfer: "WHALE",
  supply_change: "SUPPLY",
  band_change: "BAND",
};

export const RULE_HELP: Record<RuleType, string> = {
  lp_liquidity_drop: "Pool liquidity (√(r0·r1) on v2, L on v3) falls vs the peak in the window. Confirmed by Burn logs.",
  price_move: "Pool price moves vs the oldest sample in the window. Thin pools (< 0.5 WETH) are ignored.",
  spread_bps: "Live $VIBES price gap between Base Aerodrome and Robinhood Uniswap v3.",
  parity_drift: "Base locked ≠ Robinhood circulating. Circulating above locked pages immediately (unbacked).",
  escrow_window_opened: "Founder requests a tranche: the 72h backer challenge window opens.",
  escrow_window_closing: "Time left in an open challenge window crosses each mark.",
  escrow_unlock_soon: "Next tranche unlock is within the lead time (silent info).",
  escrow_challenge_or_state: "Challenge filed / resolved, or campaign enters Failed, Frozen, Refunding or Completed.",
  wallet_new_approval: "New ERC-20 / Permit2 / NFT approval from the watched wallet. Unlimited or unknown spender is CRITICAL.",
  wallet_activity: "Nonce increased: an outgoing transaction while you sleep (EOAs only).",
  proxy_upgrade: "EIP-1967 / legacy OZ implementation slot changes, with a risky-selector diff of the new code.",
  admin_change: "owner() / admin slot / Safe threshold or owners change; Paused events.",
  bridge_peer_change: "LayerZero OFT peer on the adapter no longer matches the verified counterpart.",
  whale_transfer: "A single Transfer moves at least this share of total supply.",
  supply_change: "totalSupply moves vs the armed value (increase is CRITICAL).",
  band_change: "Kestrel threat band worsens on two consecutive re-scans.",
};
