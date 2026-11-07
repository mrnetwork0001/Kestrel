import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/components/ui";

export type WordPart = string | { em: string } | "br";

/**
 * Headline split into words for a rise-in reveal (server component).
 *   <SplitWords parts={["Markets run all night.", "br", { em: "Kestrel" }, "watches the chain."]} className="t-h2" />
 * Renders real text with real spaces (readable by screen readers and crawlers, no aria-hidden):
 *   <span class="w"><span style="--i:N">word</span></span>
 * - "br" renders <br/>; { em } renders the word(s) as <em class="text-phosphor">.
 * - A non-breaking space ( ) inside a string keeps words together (one .w).
 * - mode="view" (default): data-rv="words", revealed on scroll by RevealObserver.
 *   mode="load": adds .hero-load, words rise on page load via CSS keyframes (no observer).
 * - start offsets the word index (--i); d adds a delay in ms to every word.
 */
export function SplitWords({
  parts,
  as: Tag = "h2",
  className,
  mode = "view",
  start = 0,
  d = 0,
  id,
}: {
  parts: WordPart[];
  as?: "h1" | "h2" | "h3" | "p" | "span" | "div";
  className?: string;
  mode?: "view" | "load";
  start?: number;
  d?: number;
  id?: string;
}) {
  let i = start;
  const out: ReactNode[] = [];
  let first = true;
  parts.forEach((part, pi) => {
    if (part === "br") {
      out.push(<br key={`br${pi}`} />);
      first = true;
      return;
    }
    const em = typeof part === "object";
    const words = (em ? part.em : part).split(/ +/).filter(Boolean);
    words.forEach((w, wi) => {
      if (!first) out.push(" ");
      first = false;
      const word = em ? <em className="text-phosphor">{w}</em> : w;
      out.push(
        <span key={`${pi}-${wi}`} className="w">
          <span style={{ "--i": i } as CSSProperties}>{word}</span>
        </span>
      );
      i++;
    });
  });
  const style = d ? ({ "--d": `${d}ms` } as CSSProperties) : undefined;
  return mode === "load" ? (
    <Tag id={id} className={cx("hero-load", className)} style={style}>
      {out}
    </Tag>
  ) : (
    <Tag id={id} className={className} data-rv="words" suppressHydrationWarning style={style}>
      {out}
    </Tag>
  );
}
