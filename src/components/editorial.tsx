import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/components/ui";
import { chainShort } from "@/lib/format";

/**
 * Editorial ("Night Edition") layout primitives, server components. See the motion classes in globals.css.
 * PAPER (prose, ledgers, indexes) never gets a border or fill: sections are split by hair rules.
 */

/** Page container: max 1400px, 36px left edge at 1440 on every route. `band` = full-bleed surface band. */
export function Wrap({
  as: Tag = "div",
  band,
  className,
  id,
  children,
}: {
  as?: "div" | "section" | "header" | "footer";
  band?: boolean;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  if (band) {
    return (
      <section id={id} className="band border-y border-hair" data-rv="fill" suppressHydrationWarning>
        <div className={cx("wrap", className)}>{children}</div>
      </section>
    );
  }
  return (
    <Tag id={id} className={cx("wrap", className)}>
      {children}
    </Tag>
  );
}

const KICKER_TONE = { meta: "text-ink-meta", phosphor: "text-phosphor", base: "text-base", rh: "text-rh", warn: "text-warn", crit: "text-crit" } as const;

/** Section kicker: 24x1px leading dash that draws in, 8px gap, then 11px mono uppercase (.t-kicker). */
export function Kicker({
  children,
  tone = "meta",
  rule = true,
  as: Tag = "p",
  led,
  className,
  d,
}: {
  children: ReactNode;
  tone?: keyof typeof KICKER_TONE;
  rule?: boolean;
  as?: "p" | "span" | "h2";
  led?: ReactNode;
  className?: string;
  /** Extra reveal delay (ms) for the dash. */
  d?: number;
}) {
  return (
    <Tag className={cx("t-kicker flex min-w-0 items-center gap-2", KICKER_TONE[tone], className)}>
      {rule && <span aria-hidden="true" className="inline-block h-px w-6 shrink-0 bg-current opacity-60" data-rv="rule" suppressHydrationWarning style={{ "--d": `${d ?? 0}ms` } as CSSProperties} />}
      {led}
      <span className="min-w-0">{children}</span>
    </Tag>
  );
}

/** 1px hairline that draws in (scaleX, or scaleY when vertical). `strong` = rgba(255,255,255,.16). */
export function Rule({ strong, vertical, draw = true, className, d }: { strong?: boolean; vertical?: boolean; draw?: boolean; className?: string; d?: number }) {
  return (
    <span
      aria-hidden="true"
      className={cx("block shrink-0", vertical ? "w-px self-stretch" : "h-px w-full", strong ? "bg-hair-strong" : "bg-hair", className)}
      suppressHydrationWarning
      {...(draw ? { "data-rv": "rule", ...(vertical ? { "data-axis": "y" } : {}), style: { "--d": `${d ?? 0}ms` } as CSSProperties } : {})}
    />
  );
}

/** Text link whose underline inks in on hover. No arrows; external links get a functional ↗. 44px tap target <=900px. */
export function InkLink({ href, children, external, className }: { href: string; children: ReactNode; external?: boolean; className?: string }) {
  const cls = cx("ink-target", className);
  const inner = (
    <>
      <span className="ink-line">{children}</span>
      {external && <span className="text-ink-3"> ↗</span>}
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}

/** Chain marker for lists and rows: 6px dot + "BASE"/"RH" in 11px mono, chain colour (replaces ChainBadge in rows). */
export function ChainDot({ chainId, withText = true, className }: { chainId: number; withText?: boolean; className?: string }) {
  const rh = chainId === 4663;
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 mono text-[11px] tracking-wider", rh ? "text-rh" : "text-base", className)} title={withText ? undefined : chainShort(chainId)}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {withText ? chainShort(chainId) : <span className="sr-only">{chainShort(chainId)}</span>}
    </span>
  );
}

/** Loading placeholder: ruled lines at fixed heights (no CLS) + a blinking-cursor caption. Static under reduced motion. */
export function SkeletonRows({ rows = 3, caption = "Reading Base & Robinhood Chain", heights, className }: { rows?: number; caption?: string; heights?: number[]; className?: string }) {
  const hs = heights ?? Array.from({ length: rows }, () => 40);
  return (
    <div className={cx("divide-y divide-hair border-y border-hair", className)} aria-busy="true">
      {hs.map((h, i) => (
        <div key={i} className="flex items-center" style={{ height: h }}>
          <span className={cx("skel h-2.5 rounded-[2px] bg-white/[0.06]", i % 2 ? "w-2/3" : "w-5/6")} style={{ "--i": i } as CSSProperties} />
        </div>
      ))}
      <p className="t-meta cursor-blink py-2">{caption}</p>
    </div>
  );
}
