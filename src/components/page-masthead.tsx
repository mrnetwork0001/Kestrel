import type { CSSProperties, ReactNode } from "react";
import { Kicker, Rule, Wrap } from "@/components/editorial";
import { rv, SplitWords, type WordPart } from "@/components/motion";
import { cx } from "@/components/ui";
import { Toc, type TocItem } from "@/components/toc";

/**
 * Shared editorial chrome for the content pages (/how-it-works, /agents, /ecosystem, 404, error).
 * Server components only; every hidden "before" state comes from the foundation reveal CSS (html.js scoped),
 * so with JS off or reduced motion everything below renders in its final state.
 */

type KickerTone = "meta" | "phosphor" | "base" | "rh" | "warn" | "crit";

/** Page masthead: kicker, load-animated serif h1 (max 18ch), standfirst, meta line, then a full-bleed drawn rule. */
export function PageMasthead({
  kicker,
  title,
  dek,
  meta,
  tone = "phosphor",
}: {
  kicker: string;
  title: WordPart[];
  dek?: ReactNode;
  meta?: ReactNode;
  tone?: KickerTone;
}) {
  return (
    <header>
      <Wrap className="pb-12 pt-16 max-[901px]:pb-9 max-[901px]:pt-9">
        <Kicker tone={tone}>{kicker}</Kicker>
        <SplitWords as="h1" mode="load" parts={title} className="t-hero mt-5 max-w-[18ch] !text-[clamp(40px,5.6vw,80px)]" />
        {dek && (
          <p className="hl t-stand mt-6 max-w-[40ch] !text-ink-2" style={{ "--hd": "300ms" } as CSSProperties}>
            {dek}
          </p>
        )}
        {meta && (
          <div className="hl t-meta mt-5 flex flex-wrap items-center gap-x-4 gap-y-1" style={{ "--hd": "420ms" } as CSSProperties}>
            {meta}
          </div>
        )}
      </Wrap>
      <Rule strong />
    </header>
  );
}

/** 12-column body: sticky Toc in columns 1–3, reading area in 4–12. Toc becomes a horizontal anchor line <=900px. */
export function DocGrid({ toc, children, className }: { toc: TocItem[]; children: ReactNode; className?: string }) {
  return (
    <Wrap className={cx("grid grid-cols-12 gap-x-6 pt-12 max-[901px]:block max-[901px]:pt-0", className)}>
      {/* display:contents <=900px so the sticky anchor line sticks across the whole body, not just its own box */}
      <div className="col-span-3 min-w-0 max-[901px]:contents">
        <Toc items={toc} />
      </div>
      <div className="col-span-9 min-w-0 max-[901px]:pt-8">{children}</div>
    </Wrap>
  );
}

/**
 * One chapter of a content page: hair-strong top rule (draws), kicker, 40px serif h2, prose in a 66ch reading column,
 * optional margin sidenote (13px mono, desktop right margin) and optional `wide` instrument content that breaks out
 * across the full reading area (code plates, playground).
 */
export function Chapter({
  id,
  kicker,
  tone = "meta",
  title,
  side,
  wide,
  children,
  className,
  kickerClass,
}: {
  id: string;
  kicker: ReactNode;
  /** e.g. "!normal-case !tracking-normal text-[13px]" for an endpoint method/path kicker. */
  kickerClass?: string;
  tone?: KickerTone;
  title: WordPart[];
  side?: ReactNode;
  wide?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={cx("scroll-mt-28 pb-16 max-[901px]:pb-12", className)}>
      <Rule strong />
      <div className="grid gap-x-8 pt-8 min-[1101px]:grid-cols-[minmax(0,1fr)_200px]">
        <div className="min-w-0">
          <Kicker tone={tone} d={80} className={kickerClass}>
            {kicker}
          </Kicker>
          <SplitWords id={`${id}-h`} parts={title} d={140} className="mt-4 max-w-[22ch] font-serif text-[40px] leading-[1.05] tracking-[-0.01em] text-ink [text-wrap:balance] max-[601px]:text-[32px]" />
          {children && (
            <div {...rv(0, "up", 300)} className="doc-prose mt-5 max-w-[66ch] space-y-5 text-[17px] leading-[1.6] text-ink-2 [&_p]:[text-wrap:pretty] max-[601px]:text-[16px]">
              {children}
            </div>
          )}
        </div>
        {side && (
          <aside {...rv(1, "up", 380)} className="min-w-0 pt-1 mono text-[13px] leading-relaxed text-ink-meta max-[1100px]:mt-8 max-[1100px]:border-t max-[1100px]:border-hair max-[1100px]:pt-4 min-[1101px]:border-l min-[1101px]:border-hair min-[1101px]:pl-4">
            {side}
          </aside>
        )}
      </div>
      {wide && <div className="mt-8 min-w-0">{wide}</div>}
    </section>
  );
}

/** 26px serif sub-heading inside a chapter. */
export function H3({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="!mt-10 font-serif text-[26px] leading-[1.15] text-ink [text-wrap:balance]">
      {children}
    </h3>
  );
}

/** Inline code token inside prose. */
export function C({ children }: { children: ReactNode }) {
  return <code className="mono text-[0.86em] text-ink">{children}</code>;
}

/**
 * Code / response plate (an instrument: bordered, canvas fill). `lines` reveals line by line like a teletype
 * (clip-path, foundation `lines` variant). Content is plain text.
 */
export function Plate({ children, label, lines = false, className }: { children: string; label?: ReactNode; lines?: boolean; className?: string }) {
  const rows = children.split("\n");
  return (
    <figure className={cx("min-w-0 border border-hair-strong bg-canvas", className)}>
      {label && <figcaption className="flex items-center justify-between gap-3 border-b border-hair px-4 py-2 t-meta">{label}</figcaption>}
      <pre
        {...(lines ? { "data-rv": "lines" } : {})}
        className="max-w-full overflow-x-auto p-4 mono text-[12.5px] leading-[1.65] text-ink-2 [-webkit-overflow-scrolling:touch] max-[601px]:p-3 max-[601px]:text-[12px]"
      >
        {lines
          ? rows.map((l, i) => (
              <span key={i} className="ln block" style={{ "--i": i } as CSSProperties}>
                {l || " "}
              </span>
            ))
          : children}
      </pre>
    </figure>
  );
}

/** Ruled definition list (frozen DataList signature from spec §4; local until data/data-list lands). */
export function DataList({ rows, dense }: { rows: { label: string; value: ReactNode; sub?: ReactNode }[]; dense?: boolean }) {
  return (
    <dl className="divide-y divide-hair border-y border-hair">
      {rows.map((r) => (
        <div key={r.label} className={cx("grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-baseline gap-x-6 max-[601px]:grid-cols-1 max-[601px]:gap-y-1", dense ? "min-h-8 py-2" : "min-h-10 py-2.5")}>
          <dt className="mono text-[13px] text-ink [overflow-wrap:anywhere]">{r.label}</dt>
          <dd className="min-w-0 text-[14px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
            {r.value}
            {r.sub && <span className="mt-0.5 block t-meta">{r.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Numbered, ruled procedure (real sequences only). */
export function Procedure({ steps }: { steps: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="divide-y divide-hair border-y border-hair">
      {steps.map((s, i) => (
        <li key={s.title} {...rv(i)} className="grid grid-cols-[48px_minmax(0,1fr)] gap-x-4 py-5 max-[601px]:grid-cols-[32px_minmax(0,1fr)]">
          <span className="mono text-[13px] tnum text-phosphor">{String(i + 1).padStart(2, "0")}</span>
          <div className="min-w-0">
            <p className="text-[16px] font-medium text-ink">{s.title}</p>
            <div className="mt-1.5 text-[15px] leading-relaxed text-ink-2 [text-wrap:pretty]">{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Closing action row: one filled primary + outline secondaries. */
export function DocActions({ children }: { children: ReactNode }) {
  return (
    <div {...rv(0)} className="flex flex-wrap gap-3 pt-4 max-[601px]:[&>*]:w-full">
      {children}
    </div>
  );
}
