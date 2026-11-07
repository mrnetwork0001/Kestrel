import type { CSSProperties } from "react";
import type { TrancheStatus, TrancheView } from "@/lib/engine/types";
import { fmtUnits, fmtUtc } from "@/lib/format";
import { cx } from "@/components/ui";

const SEG: Record<TrancheStatus, string> = {
  PAID: "bg-phosphor/70",
  CHALLENGE_WINDOW: "bg-warn",
  CHALLENGED: "bg-crit",
  HALTED: "bg-crit",
  CLAIMABLE: "bg-base/60",
  ELIGIBLE: "bg-base/60",
  LOCKED: "bg-white/10",
};

const STATUS_TEXT: Record<TrancheStatus, string> = {
  PAID: "Paid",
  CHALLENGE_WINDOW: "72h challenge window open",
  CHALLENGED: "Challenged",
  HALTED: "Halted",
  CLAIMABLE: "Claimable",
  ELIGIBLE: "Eligible to request",
  LOCKED: "Locked",
};

function shortLabel(_t: TrancheView, k: number) {
  return k === 0 ? "KICK" : `M${k}`;
}

/**
 * The 10% kickstart + six 15% monthly tranches as one ruler. Segment widths = tranche bps (flex-grow),
 * colours = live onchain status. Segments fill left to right (data-rv="bar", 70ms stagger).
 */
export function TrancheRuler({
  tranches,
  size = "m",
  showAmounts = false,
  showDates = false,
  className,
}: {
  tranches: TrancheView[];
  size?: "s" | "m" | "l";
  showAmounts?: boolean;
  showDates?: boolean;
  className?: string;
}) {
  const h = size === "s" ? "h-1" : size === "l" ? "h-3" : "h-2";
  return (
    <div data-rv="bar" suppressHydrationWarning className={cx("flex w-full min-w-0 gap-[3px]", className)} role="list" aria-label="Escrow tranches">
      {tranches.map((t, k) => {
        const status = STATUS_TEXT[t.status] ?? t.status;
        const title = `${t.label}: ${status} · ${fmtUnits(t.amount, 18, 4)} ETH`;
        return (
          <div key={t.index} role="listitem" title={title} className="min-w-0" style={{ flexGrow: Math.max(1, t.bps), flexBasis: 0 }}>
            <span className={cx("block w-full overflow-hidden bg-white/[0.05]", h)}>
              <span className={cx("bar-fill block h-full w-full", SEG[t.status] ?? "bg-white/10")} style={{ "--i": k } as CSSProperties} />
            </span>
            <span className="mt-1.5 block truncate mono text-[12px] text-ink-meta">
              {shortLabel(t, k)}
              <span className="sr-only"> {status}</span>
            </span>
            {showAmounts && <span className="block truncate mono tnum text-[12px] text-ink-2">{fmtUnits(t.amount, 18, 2)}</span>}
            {showDates && t.unlockTime > 0 && <span className="block truncate mono text-[11px] text-ink-meta">{fmtUtc(t.unlockTime).slice(0, 10)}</span>}
          </div>
        );
      })}
    </div>
  );
}
