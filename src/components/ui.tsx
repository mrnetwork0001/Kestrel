import type { CSSProperties, ReactNode } from "react";
import { chainShort, explorerAddress, explorerTx, shortAddr } from "@/lib/format";
import type { Severity, ThreatBand } from "@/lib/engine/types";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function SectionLabel({ n, children, className }: { n?: string; children: ReactNode; className?: string }) {
  return (
    <p className={cx("label", className)}>
      [ {n ? `${n} // ` : ""}
      {children} ]
    </p>
  );
}

/**
 * Panel. variant="section" (default) is PAPER: a hair-strong top rule, kicker title, no fill, no padding.
 * variant="instrument" keeps the bordered .panel chrome for things you type into, press, or live machine state.
 * `n` is accepted for old call sites and ignored (no numbered labels).
 */
export function Panel({
  children,
  className,
  title,
  right,
  heading,
  variant = "section",
  reveal,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  /** @deprecated accepted, ignored */
  n?: string;
  right?: ReactNode;
  heading?: string;
  variant?: "section" | "instrument";
  reveal?: number;
}) {
  const rvProps = reveal != null ? { "data-rv": "up", style: { "--i": reveal } as CSSProperties } : {};
  if (variant === "instrument") {
    return (
      <section {...rvProps} className={cx("panel min-w-0 max-w-full max-[901px]:overflow-x-clip", className)}>
        {(title || right) && (
          <header className="flex items-center justify-between gap-3 border-b hairline px-4 py-2.5 max-[601px]:flex-wrap max-[601px]:gap-y-1 max-[601px]:px-3">
            {title ? <SectionLabel className="min-w-0">{title}</SectionLabel> : <span />}
            {right && <div className="min-w-0 text-[12px] text-ink-meta">{right}</div>}
          </header>
        )}
        {heading && <h3 className="px-4 pt-4 font-serif text-[24px] leading-[1.15] text-ink max-[601px]:px-3">{heading}</h3>}
        <div className="p-4 max-[601px]:p-3">{children}</div>
      </section>
    );
  }
  return (
    <section {...rvProps} className={cx("min-w-0 max-w-full border-t border-hair-strong pt-4", className)}>
      {(title || right) && (
        <header className="mb-3 flex items-baseline justify-between gap-3 max-[601px]:flex-wrap max-[601px]:gap-y-1">
          {title ? <h2 className="t-kicker min-w-0">{title}</h2> : <span />}
          {right && <div className="min-w-0 text-[12px] text-ink-meta">{right}</div>}
        </header>
      )}
      {heading && <h3 className="mb-4 font-serif text-[24px] leading-[1.15] text-ink">{heading}</h3>}
      {children}
    </section>
  );
}

export function ChainBadge({ chainId, className }: { chainId: number; className?: string }) {
  const rh = chainId === 4663;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-1.5 py-0.5 mono text-[10px] tracking-wider",
        rh ? "border-rh/30 text-rh" : "border-base/30 text-base",
        className
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", rh ? "bg-rh" : "bg-base")} />
      {chainShort(chainId)} · {chainId}
    </span>
  );
}

const BAND_STYLE: Record<ThreatBand, string> = {
  NOMINAL: "text-phosphor border-phosphor/30",
  ELEVATED: "text-warn border-warn/30",
  CRITICAL: "text-crit border-crit/40",
};

export function BandBadge({ band, className }: { band: ThreatBand; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1.5 rounded-[2px] border px-1.5 py-0.5 mono text-[11px] tracking-wider", BAND_STYLE[band], className)}>● {band}</span>;
}

export const SEVERITY_COLOR: Record<Severity, string> = {
  info: "text-ink-meta",
  warn: "text-warn",
  critical: "text-crit",
};

export function AddrLink({ chainId, address, label, n = 4, className }: { chainId: number; address: string; label?: string; n?: number; className?: string }) {
  return (
    <a href={explorerAddress(chainId, address)} target="_blank" rel="noreferrer" className={cx("mono text-ink-2 underline decoration-white/10 underline-offset-2 [overflow-wrap:anywhere] hover:text-ink hover:decoration-white/40 max-[901px]:py-1", className)} title={address}>
      {label ?? shortAddr(address, n)} <span className="text-ink-meta">↗</span>
    </a>
  );
}

export function TxLink({ chainId, hash, label, className }: { chainId: number; hash: string; label?: string; className?: string }) {
  return (
    <a href={explorerTx(chainId, hash)} target="_blank" rel="noreferrer" className={cx("mono text-ink-2 underline decoration-white/10 underline-offset-2 [overflow-wrap:anywhere] hover:text-ink max-[901px]:py-1", className)} title={hash}>
      {label ?? shortAddr(hash, 6)} <span className="text-ink-meta">↗</span>
    </a>
  );
}

const STAT_SIZE = {
  s: "text-[16px] leading-tight",
  m: "text-[24px] leading-[1.1] max-[601px]:text-[20px]",
  l: "text-[40px] leading-none max-[601px]:text-[32px]",
  xl: "text-[56px] leading-[0.95] tracking-[-0.02em] max-[601px]:text-[44px]",
} as const;

export function Stat({
  label,
  value,
  sub,
  tone,
  size = "m",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "phosphor" | "warn" | "crit" | "base" | "rh";
  size?: "s" | "m" | "l" | "xl";
  className?: string;
}) {
  const toneCls = tone ? { phosphor: "text-phosphor", warn: "text-warn", crit: "text-crit", base: "text-base", rh: "text-rh" }[tone] : "text-ink";
  return (
    <div className={cx("min-w-0", className)}>
      <p className="t-kicker">{label}</p>
      <p className={cx("mt-1.5 mono tnum [overflow-wrap:anywhere]", STAT_SIZE[size], toneCls)}>{value}</p>
      {sub && <p className="mt-1 mono text-[12px] text-ink-meta">{sub}</p>}
    </div>
  );
}

/** Threat gauge: 0–100 hairline bar with band thresholds at 30 and 65. */
export function ScoreGauge({ score, band }: { score: number; band: ThreatBand }) {
  const color = band === "CRITICAL" ? "bg-crit" : band === "ELEVATED" ? "bg-warn" : "bg-phosphor";
  const text = band === "CRITICAL" ? "text-crit" : band === "ELEVATED" ? "text-warn" : "text-phosphor";
  return (
    <div>
      <div className="flex items-end gap-3">
        <span className={cx("tnum text-[56px] leading-none max-[601px]:text-[48px]", text)}>{score}</span>
        <span className="mb-1.5 mono text-[12px] text-ink-meta">/ 100</span>
        <BandBadge band={band} className="mb-2 ml-auto" />
      </div>
      <div className="relative mt-3 h-1.5 w-full bg-white/[0.06]">
        <div className={cx("absolute inset-y-0 left-0", color)} style={{ width: `${Math.max(2, score)}%` }} />
        <div className="absolute inset-y-[-3px] left-[30%] w-px bg-white/25" />
        <div className="absolute inset-y-[-3px] left-[65%] w-px bg-white/25" />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 mono text-[11px] text-ink-meta">
        <span>NOMINAL 0–29</span>
        <span>ELEVATED 30–64</span>
        <span>CRITICAL 65+</span>
      </div>
    </div>
  );
}
