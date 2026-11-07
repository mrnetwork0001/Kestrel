import { cx } from "@/components/ui";

export function presetTab(kind: string) {
  return kind === "escrow" ? "shield" : kind === "pool" ? "chaos" : "briefing";
}

/** findings.ts prints "<amount> WETH WETH reserve"; collapse the doubled unit until that string is fixed at the source. */
export function tidy(s: string) {
  return s.replace(/\bWETH WETH\b/g, "WETH");
}

/** <=900px: standalone text links get a 36px touch target (desktop unchanged). */
export const TAP = "max-[901px]:inline-flex max-[901px]:min-h-9 max-[901px]:items-center max-[901px]:gap-1";

export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("space-y-3", className)} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cx("h-3 animate-pulse rounded-[2px] bg-white/[0.06]", i % 2 ? "w-2/3" : "w-5/6")} />
      ))}
      <p className="mono text-[11px] text-ink-3 cursor-blink">Reading Base &amp; Robinhood Chain</p>
    </div>
  );
}
