import type { ReactNode } from "react";
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

export function Panel({ children, className, title, n, right }: { children: ReactNode; className?: string; title?: string; n?: string; right?: ReactNode }) {
  return (
    <section className={cx("panel min-w-0 max-w-full max-[900px]:overflow-x-clip", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b hairline px-4 py-2.5 max-[600px]:flex-wrap max-[600px]:gap-y-1 max-[600px]:px-3">
          <SectionLabel n={n} className="min-w-0">{title}</SectionLabel>
          {right}
        </header>
      )}
      <div className="p-4 max-[600px]:p-3">{children}</div>
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
  info: "text-ink-3",
  warn: "text-warn",
  critical: "text-crit",
};

export function AddrLink({ chainId, address, label, n = 4, className }: { chainId: number; address: string; label?: string; n?: number; className?: string }) {
  return (
    <a href={explorerAddress(chainId, address)} target="_blank" rel="noreferrer" className={cx("mono text-ink-2 underline decoration-white/10 underline-offset-2 [overflow-wrap:anywhere] hover:text-ink hover:decoration-white/40 max-[900px]:py-1", className)} title={address}>
      {label ?? shortAddr(address, n)} <span className="text-ink-3">↗</span>
    </a>
  );
}

export function TxLink({ chainId, hash, label, className }: { chainId: number; hash: string; label?: string; className?: string }) {
  return (
    <a href={explorerTx(chainId, hash)} target="_blank" rel="noreferrer" className={cx("mono text-ink-2 underline decoration-white/10 underline-offset-2 [overflow-wrap:anywhere] hover:text-ink max-[900px]:py-1", className)} title={hash}>
      {label ?? shortAddr(hash, 6)} <span className="text-ink-3">↗</span>
    </a>
  );
}

export function Stat({ label, value, sub, tone, className }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "phosphor" | "warn" | "crit" | "base" | "rh"; className?: string }) {
  const toneCls = tone ? { phosphor: "text-phosphor", warn: "text-warn", crit: "text-crit", base: "text-base", rh: "text-rh" }[tone] : "text-ink";
  return (
    <div className={cx("min-w-0", className)}>
      <p className="label">{label}</p>
      <p className={cx("mt-1 tnum text-[20px] leading-tight [overflow-wrap:anywhere] max-[600px]:text-[18px]", toneCls)}>{value}</p>
      {sub && <p className="mt-0.5 mono text-[11px] text-ink-3">{sub}</p>}
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
        <span className={cx("tnum text-[56px] leading-none max-[600px]:text-[48px]", text)}>{score}</span>
        <span className="mb-1.5 mono text-[12px] text-ink-3">/ 100</span>
        <BandBadge band={band} className="mb-2 ml-auto" />
      </div>
      <div className="relative mt-3 h-1.5 w-full bg-white/[0.06]">
        <div className={cx("absolute inset-y-0 left-0", color)} style={{ width: `${Math.max(2, score)}%` }} />
        <div className="absolute inset-y-[-3px] left-[30%] w-px bg-white/25" />
        <div className="absolute inset-y-[-3px] left-[65%] w-px bg-white/25" />
      </div>
      <div className="mt-1.5 flex justify-between gap-2 mono text-[10px] text-ink-3 max-[600px]:text-[9px]">
        <span>NOMINAL 0–29</span>
        <span>ELEVATED 30–64</span>
        <span>CRITICAL 65+</span>
      </div>
    </div>
  );
}
