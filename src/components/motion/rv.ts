import type { CSSProperties } from "react";

export type RevealVariant = "up" | "rule" | "settle" | "bar" | "lines" | "words" | "fill";

/**
 * Scroll-reveal props, server-safe. Spread onto any element:
 *   <p {...rv(2)}>…</p>                  fade-up, 3rd in the stagger
 *   <span {...rv(0, "rule", 120)} />     draws a hairline 120ms after it enters
 * The hidden "before" state only exists under <html class="js"> (see globals.css + layout.tsx), so no-JS,
 * crawlers and prefers-reduced-motion always get the final, visible markup. RevealObserver sets data-in.
 */
export function rv(i?: number, variant?: RevealVariant, d?: number): { "data-rv": RevealVariant; style: CSSProperties; suppressHydrationWarning: true } {
  return { "data-rv": variant ?? "up", suppressHydrationWarning: true, style: { "--i": i ?? 0, "--d": `${d ?? 0}ms` } as CSSProperties };
}
