import type { CSSProperties, ReactNode } from "react";
import { fmtCompact } from "@/lib/format";
import { cx } from "@/components/ui";

export type ProportionSide = { value: string /* wei */; label: ReactNode; tone: "base" | "rh" };

function toBig(v: string): bigint {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/** Ratio of v to max, computed in BigInt and only then narrowed to a 0..1 display ratio (4 dp). */
function ratio(v: bigint, max: bigint): number {
  if (max <= 0n || v <= 0n) return 0;
  return Number((v * 10000n) / max) / 10000;
}

const TONE: Record<ProportionSide["tone"], { bar: string; text: string; name: string }> = {
  base: { bar: "bg-base", text: "text-base", name: "Base" },
  rh: { bar: "bg-rh", text: "text-rh", name: "Robinhood" },
};

/**
 * Two real token quantities as proportional 6px bars on one shared scale (paper, no box).
 * Bars fill together on reveal (data-rv="bar"); without JS or under reduced motion they render full width.
 */
export function ProportionBars({ a, b, decimals = 18, className }: { a: ProportionSide; b: ProportionSide; decimals?: number; className?: string }) {
  const va = toBig(a.value);
  const vb = toBig(b.value);
  const max = va > vb ? va : vb;
  const rows = [
    { side: a, v: va },
    { side: b, v: vb },
  ];
  const aria = rows.map(({ side, v }) => `${TONE[side.tone].name} ${fmtCompact(v, decimals)}`).join(", ");
  return (
    <div role="img" aria-label={aria} data-rv="bar" suppressHydrationWarning className={cx("grid gap-3", className)}>
      {rows.map(({ side, v }, k) => {
        const t = TONE[side.tone];
        return (
          <div key={k} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1.5" aria-hidden="true">
            <span className="min-w-0 truncate text-[13px] text-ink-2">{side.label}</span>
            <span className={cx("mono tnum text-[15px]", t.text)}>{fmtCompact(v, decimals)}</span>
            <span className="col-span-2 block h-1.5 w-full overflow-hidden bg-white/[0.06]">
              <span className={cx("bar-fill block h-full w-full", t.bar)} style={{ "--v": ratio(v, max), "--i": k } as CSSProperties} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
