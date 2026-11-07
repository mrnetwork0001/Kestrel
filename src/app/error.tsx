"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Kicker, Wrap } from "@/components/editorial";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Wrap className="py-24 max-[901px]:py-12">
      <div className="max-w-[880px] border-l-2 border-warn pl-8 max-[601px]:pl-5">
        <Kicker tone="warn">Read interrupted</Kicker>
        <h1 className="t-hero mt-5 max-w-[18ch]">A live read did not come back.</h1>
        <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-ink-2">
          Kestrel never shows placeholder numbers, so this view stopped instead. Public RPCs on Base and Robinhood Chain occasionally rate-limit; retrying usually clears it.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button onClick={reset} className="btn-primary press">
            RETRY READ
          </button>
          <Link href="/" className="btn-ghost press">
            BACK TO BRIEFING
          </Link>
          {error.digest && <span className="t-meta">ref {error.digest}</span>}
        </div>
      </div>
    </Wrap>
  );
}
