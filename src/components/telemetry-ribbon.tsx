import { getRibbonTelemetry } from "@/lib/engine/telemetry";
import { explorerBlock } from "@/lib/format";
import { NightShiftClock } from "./night-shift-clock";

function fmtBlock(b: string | null) {
  return b ? `#${BigInt(b).toLocaleString("en-US")}` : "—";
}

export async function TelemetryRibbon() {
  const t = await getRibbonTelemetry();
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
