import type { ReactNode } from "react";
import { cx } from "@/components/ui";

export type DataTone = "phosphor" | "warn" | "crit" | "base" | "rh" | "meta";
export type DataRow = { label: string; value: ReactNode; sub?: ReactNode; tone?: DataTone };

const TONE: Record<DataTone, string> = {
  phosphor: "text-phosphor",
  warn: "text-warn",
  crit: "text-crit",
  base: "text-base",
  rh: "text-rh",
  meta: "text-ink-meta",
};

/** A ruled definition list (paper): label left in ink-2, value right in mono ink. No borders around it. */
export function DataList({ rows, dense = false, className }: { rows: DataRow[]; dense?: boolean; className?: string }) {
  return (
    <dl className={cx("divide-y divide-hair", className)}>
      {rows.map((r, k) => (
        <div key={`${r.label}-${k}`} className={cx("flex items-baseline justify-between gap-4 py-2", dense ? "min-h-8" : "min-h-10")}>
          <dt className="min-w-0 shrink text-[13px] text-ink-2">{r.label}</dt>
          <dd className="min-w-0 text-right">
            <span className={cx("mono tnum text-[15px] [overflow-wrap:anywhere]", r.tone ? TONE[r.tone] : "text-ink")}>{r.value}</span>
            {r.sub != null && r.sub !== false && <span className="mt-0.5 block mono text-[12px] text-ink-meta">{r.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
