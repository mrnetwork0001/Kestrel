"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { isAddress } from "viem";
import { cx } from "@/components/ui";

/** Landing hero omnibar: any Base / Robinhood Chain address → the live workspace scan (no wallet). */
export function LandingOmnibar() {
  const router = useRouter();
  const [chain, setChain] = useState<8453 | 4663>(8453);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!isAddress(v, { strict: false })) {
      setError("Enter a valid 0x address (40 hex characters).");
      return;
    }
    setError(null);
    router.push(`/app?${new URLSearchParams({ target: v, chain: String(chain), tab: "briefing" }).toString()}`);
  };

  return (
    <div>
      <form onSubmit={onSubmit} className="panel flex flex-col gap-2 p-2 sm:flex-row sm:items-stretch" role="search" aria-label="Scan any address">
        <div className="flex shrink-0 overflow-hidden rounded-[2px] border hairline mono text-[11px]">
          {([8453, 4663] as const).map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setChain(c)}
              aria-pressed={chain === c}
              className={cx("flex-1 whitespace-nowrap px-3 py-2 tracking-wider transition-colors", chain === c ? (c === 4663 ? "bg-rh/15 text-rh" : "bg-base/15 text-base") : "text-ink-3 hover:text-ink")}
            >
              {c === 4663 ? "ROBINHOOD 4663" : "BASE 8453"}
            </button>
          ))}
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <span className="mono text-[13px] text-phosphor">&gt;_</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste any wallet, token, pool or escrow 0x…"
            spellCheck={false}
            autoComplete="off"
            className="w-full min-w-0 bg-transparent py-2 mono text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
            aria-label="Address to scan"
          />
        </label>
        <button type="submit" className="rounded-[2px] bg-phosphor px-5 py-2 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698]">
          RUN SCAN
        </button>
      </form>
      {error && <p className="mt-2 mono text-[12px] text-crit">{error}</p>}
    </div>
  );
}
