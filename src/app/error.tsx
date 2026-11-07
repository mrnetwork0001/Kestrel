"use client";

import Link from "next/link";
import { useEffect } from "react";
import { SectionLabel } from "@/components/ui";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[880px] px-4 py-24">
      <SectionLabel n="ERR">Read interrupted</SectionLabel>
      <div className="panel mt-4 p-6">
        <h1 className="font-serif text-[44px] leading-tight text-ink">A live read did not come back.</h1>
        <p className="mt-3 max-w-[560px] text-[14px] text-ink-2">
          Kestrel never shows placeholder numbers, so this view stopped instead. Public RPCs on Base and Robinhood Chain occasionally rate-limit; retrying usually clears it.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button onClick={reset} className="rounded-[2px] bg-phosphor px-4 py-2 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698]">
            RETRY READ
          </button>
          <Link href="/" className="rounded-[2px] border border-hair-strong px-4 py-2 mono text-[12px] text-ink-2 hover:text-ink">
            BACK TO BRIEFING
          </Link>
          {error.digest && <span className="mono text-[11px] text-ink-3">ref {error.digest}</span>}
        </div>
      </div>
    </div>
  );
}
