"use client";

import { useEffect, useState } from "react";
import type { RibbonTelemetry } from "@/lib/engine/telemetry";
import { explorerBlock } from "@/lib/format";
import { NightShiftClock } from "./night-shift-clock";

const POLL_MS = 30_000;

function fmtBlock(b: string | null) {
  return b ? `#${BigInt(b).toLocaleString("en-US")}` : "—";
}

/**
 * Client half of the ribbon: paints the server-read values, then refreshes from /api/telemetry. Static and ISR pages
 * bake the ribbon at build/regeneration time, so a stale snapshot is refreshed immediately on mount.
 */
export function TelemetryRibbonLive({ initial }: { initial: RibbonTelemetry }) {
  const [t, setT] = useState(initial);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/telemetry", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as RibbonTelemetry;
        if (!stopped && next && typeof next.fetchedAt === "string") setT(next);
      } catch {
        /* keep the last good values */
      }
    };
    if (Date.now() - Date.parse(initial.fetchedAt) > 20_000 || initial.parity === "UNKNOWN" || !initial.baseBlock || !initial.rhBlock) void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [initial]);

  const parityColor = t.parity === "VERIFIED" ? "text-phosphor" : t.parity === "DRIFT" ? "text-warn" : "text-ink-3";
  return (
    <div className="border-b hairline bg-canvas/95">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-1.5 mono text-[11px] text-ink-2">
        <a href={t.baseBlock ? explorerBlock(8453, t.baseBlock) : "#"} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-ink">
          <span className="dot-live inline-block h-1.5 w-1.5 rounded-full bg-base" />
          <span className="text-ink-3">BASE</span>
          <span className="tnum">{fmtBlock(t.baseBlock)}</span>
        </a>
        <a href={t.rhBlock ? explorerBlock(4663, t.rhBlock) : "#"} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-ink">
          <span className="dot-live inline-block h-1.5 w-1.5 rounded-full bg-rh" />
          <span className="text-ink-3">ROBINHOOD</span>
          <span className="tnum">{fmtBlock(t.rhBlock)}</span>
        </a>
        <span className="flex items-center gap-1.5">
          <span className="text-ink-3">$VIBES OFT 1:1</span>
          <span className={parityColor}>● {t.parity}</span>
        </span>
        <span className="ml-auto">
          <NightShiftClock />
        </span>
      </div>
    </div>
  );
}
