import Link from "next/link";
import type { CSSProperties } from "react";
import { Rule, Wrap } from "@/components/editorial";
import { rv } from "@/components/motion";

/** One word for the data-rv="words" rise (same markup SplitWords emits). */
function W({ i, children }: { i: number; children: string }) {
  return (
    <span className="w">
      <span style={{ "--i": i } as CSSProperties}>{children}</span>
    </span>
  );
}

/** S6 · Closing: no box. A full-width rule draws, the line rises word by word, "night shift" gets a drawn phosphor underline. */
export function FinalCtaSection() {
  return (
    <Wrap as="section" id="launch" className="pt-32 pb-24 max-[901px]:pt-[88px] max-[901px]:pb-[72px] max-[601px]:pt-16 max-[601px]:pb-16">
      <Rule strong />
      <h2 className="t-display-xl mt-14 max-w-[14ch] max-[601px]:mt-10" data-rv="words" suppressHydrationWarning style={{ "--d": "80ms" } as CSSProperties}>
        <W i={0}>Hand</W> <W i={1}>Kestrel</W> <W i={2}>the</W>{" "}
        <span className="whitespace-nowrap">
          <span className="relative inline-block">
            <W i={3}>night</W> <W i={4}>shift</W>
            <span aria-hidden="true" className="absolute inset-x-0 bottom-[0.02em] block h-[2px] bg-phosphor" {...rv(0, "rule", 420)} />
          </span>
          <W i={5}>.</W>
        </span>
      </h2>
      <div className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-4 max-[601px]:mt-10" {...rv(0, "up", 520)}>
        <Link href="/app" className="btn-primary press max-[601px]:w-full">
          LAUNCH APP
        </Link>
        <p className="text-[15px] text-ink-2">Paste any address. No signup, no wallet, no mock data.</p>
      </div>
    </Wrap>
  );
}
