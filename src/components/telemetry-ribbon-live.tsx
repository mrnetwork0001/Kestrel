"use client";

import { useEffect, useState } from "react";
import type { RibbonTelemetry } from "@/lib/engine/telemetry";
import { explorerBlock } from "@/lib/format";
import { Led, type LedTone } from "./motion/led";
import { NightShiftClock } from "./night-shift-clock";

const POLL_MS = 30_000;

/** Signed parity verdict labels (same vocabulary as the parity desk); critical colour only for UNBACKED. */
const PARITY: Record<RibbonTelemetry["parity"], { label: string; tone: LedTone; cls: string }> = {
  VERIFIED: { label: "EXACT", tone: "phosphor", cls: "text-phosphor" },
  IN_FLIGHT: { label: "IN FLIGHT", tone: "phosphor", cls: "text-ink" },
  OVER_BACKED: { label: "OVER BACKED", tone: "phosphor", cls: "text-ink" },
  BACKED: { label: "BACKED", tone: "phosphor", cls: "text-ink" },
  DRIFT: { label: "UNBACKED", tone: "crit", cls: "text-crit" },
  UNKNOWN: { label: "UNREAD", tone: "idle", cls: "text-ink-meta" },
};

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

  const p = PARITY[t.parity] ?? PARITY.UNKNOWN;
  const ms = (v: number | null | undefined) => (v == null ? null : `${v} ms`);
  return (
    <div className="border-b hairline bg-canvas/95">
      <div className="wrap flex flex-wrap items-center gap-x-6 gap-y-1 py-1.5 mono text-[11px] text-ink-2">
        <a href={t.baseBlock ? explorerBlock(8453, t.baseBlock) : "#"} target="_blank" rel="noreferrer" className="flex items-center gap-2 transition-colors duration-200 hover:text-ink">
          <Led tone={t.baseBlock ? "base" : "idle"} mode="event" eventKey={t.baseBlock} />
          <span className="text-ink-meta">BASE</span>
          <span className="tnum">{fmtBlock(t.baseBlock)}</span>
          {ms(t.rpcLatencyMs?.base) && <span className="text-ink-meta max-[601px]:hidden">{ms(t.rpcLatencyMs?.base)}</span>}
        </a>
        <a href={t.rhBlock ? explorerBlock(4663, t.rhBlock) : "#"} target="_blank" rel="noreferrer" className="flex items-center gap-2 transition-colors duration-200 hover:text-ink">
          <Led tone={t.rhBlock ? "rh" : "idle"} mode="event" eventKey={t.rhBlock} />
          <span className="text-ink-meta">ROBINHOOD</span>
          <span className="tnum">{fmtBlock(t.rhBlock)}</span>
          {ms(t.rpcLatencyMs?.robinhood) && <span className="text-ink-meta max-[601px]:hidden">{ms(t.rpcLatencyMs?.robinhood)}</span>}
        </a>
        <span className="flex items-center gap-2" title="$VIBES LayerZero OFT: locked on Base vs circulating on Robinhood Chain">
          <span className="text-ink-meta">$VIBES OFT 1:1</span>
          <Led tone={p.tone} mode="event" eventKey={`${t.parity}:${t.deltaSigned ?? t.deltaRaw ?? ""}`} />
          <span className={p.cls}>{p.label}</span>
        </span>
        <span className="ml-auto">
          <NightShiftClock />
        </span>
      </div>
    </div>
  );
}
