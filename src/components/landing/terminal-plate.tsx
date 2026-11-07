import type { CSSProperties } from "react";
import { cx } from "@/components/ui";
import { Led } from "@/components/motion";

export type TerminalTone = "ink" | "meta" | "phosphor" | "warn" | "crit";
export type TerminalLine = { text: string; tone?: TerminalTone };

const TONE: Record<TerminalTone, string> = {
  ink: "text-ink",
  meta: "text-ink-meta",
  phosphor: "text-phosphor",
  warn: "text-warn",
  crit: "text-crit",
};

/**
 * Terminal plate (an INSTRUMENT, so it keeps .panel chrome). Server component.
 * Every line is a block `.ln` inside data-rv="lines": RevealObserver wipes them in like a teletype
 * (clip-path only). Without JS or with reduced motion every line is simply there. Text is plain text.
 */
export function TerminalPlate({
  title,
  lines,
  meta,
  busy,
  className,
}: {
  title: string;
  lines: TerminalLine[];
  /** Right side of the header, e.g. "BLOCK 38,201,114". */
  meta?: string;
  busy?: boolean;
  className?: string;
}) {
  return (
    <figure className={cx("panel min-w-0 overflow-hidden !bg-canvas", className)} aria-busy={busy || undefined}>
      <figcaption className="flex min-w-0 items-center justify-between gap-3 border-b border-hair px-4 py-3 sm:px-5">
        <span className="flex min-w-0 items-center gap-2.5 mono text-[11px] tracking-[0.12em] text-ink-2">
          <Led tone={busy ? "idle" : "phosphor"} />
          <span className="truncate">{title}</span>
        </span>
        {meta && <span className="shrink-0 mono text-[11px] tabular-nums text-ink-meta">{meta}</span>}
      </figcaption>
      <pre
        className="m-0 min-w-0 whitespace-pre-wrap px-4 py-5 mono text-[13px] leading-[22px] [overflow-wrap:anywhere] sm:px-5 sm:py-6"
        data-rv="lines"
        suppressHydrationWarning
      >
        <code>
          {lines.map((l, i) => (
            <span key={i} className={cx("ln block min-h-[22px]", TONE[l.tone ?? "ink"], busy && i === lines.length - 1 && "cursor-blink")} style={{ "--i": i } as CSSProperties}>
              {l.text}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
