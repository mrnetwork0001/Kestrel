import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * A real, already-formatted figure whose digits "settle" into place once (server component).
 *   <Settle value={`${fmtUnits(balance, 18, 2)} ETH`} className="t-data-l" />
 * The visible text is exactly `value` at every moment: no counting, no intermediate digits. Digits drop in
 * right-to-left (--i * 24ms), other characters fade. Pass a formatted string only, never a bigint/number.
 * The exact string is also on data-value (greppable in the raw HTML) and aria-label (role="img").
 */
export function Settle({ value, className, d }: { value: string; className?: string; d?: number }) {
  const chars = Array.from(value);
  let digitsLeft = chars.filter((c) => c >= "0" && c <= "9").length;
  const out: ReactNode[] = chars.map((c, k) => {
    if (c >= "0" && c <= "9") {
      digitsLeft--;
      return (
        <span key={k} className="d" aria-hidden="true">
          <span style={{ "--i": digitsLeft } as CSSProperties}>{c}</span>
        </span>
      );
    }
    return (
      <span key={k} className="c" aria-hidden="true">
        {c}
      </span>
    );
  });
  return (
    <span role="img" aria-label={value} data-value={value} data-rv="settle" suppressHydrationWarning className={cx("tnum whitespace-pre-wrap", className)} style={{ "--d": `${d ?? 0}ms` } as CSSProperties}>
      {out}
    </span>
  );
}
