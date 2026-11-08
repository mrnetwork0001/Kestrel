import { ImageResponse } from "next/og";
import { getBridgeParity } from "@/lib/engine/parity";
import type { ParityReport } from "@/lib/engine/types";
import { fmtBps, fmtUtc } from "@/lib/format";
import { ChainPill, Dot, Frame, OG, OG_SIZE, Wordmark, ogFontOption, within } from "@/lib/og";

export const SITE_OG_ALT = "Kestrel — Stay asleep. Kestrel watches the chain. Live Base ↔ Robinhood Chain overnight sentinel.";

function Cell({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "14px 22px", borderLeft: `1px solid ${OG.hair}` }}>
      <span style={{ fontSize: 15, letterSpacing: 3, color: OG.ink3 }}>{label}</span>
      <span style={{ marginTop: 6, fontSize: 30, color, whiteSpace: "nowrap" }}>{value}</span>
      {sub ? <span style={{ marginTop: 4, fontSize: 15, color: OG.ink3 }}>{sub}</span> : null}
    </div>
  );
}

function Telemetry({ p }: { p: ParityReport }) {
  // Verdict, not `verified`: a LayerZero packet in flight is expected, not drift. Only UNBACKED is a warning.
  const verdict = p.verdict ?? (p.verified ? "EXACT" : "IN_FLIGHT");
  const pv =
    verdict === "EXACT" ? { value: "EXACT", color: OG.phosphor, sub: "locked = circulating" }
    : verdict === "IN_FLIGHT" ? { value: "IN FLIGHT", color: OG.ink, sub: `${p.pendingPackets ?? "some"} packet${p.pendingPackets === 1 ? "" : "s"} in flight` }
    : verdict === "OVER_BACKED" ? { value: "OVER BACKED", color: OG.ink, sub: "locked > circulating" }
    : { value: "UNBACKED", color: OG.crit, sub: "circulating > locked" };
  const spreadColor = p.spreadBps === null ? OG.ink3 : Math.abs(p.spreadBps) >= 300 ? OG.warn : OG.ink;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 15, letterSpacing: 3, color: OG.ink3, marginBottom: 12 }}>
        <Dot color={OG.phosphor} size={9} />
        {`LIVE DUAL-RPC READ · ${fmtUtc(Math.max(p.base.timestamp, p.robinhood.timestamp))}`}
      </div>
      <div style={{ display: "flex", border: `1px solid ${OG.hairStrong}`, background: OG.surface, borderLeft: "none" }}>
        <Cell label="BASE 8453" value={`#${BigInt(p.base.number).toLocaleString("en-US")}`} color={OG.base} />
        <Cell label="ROBINHOOD 4663" value={`#${BigInt(p.robinhood.number).toLocaleString("en-US")}`} color={OG.rh} />
        <Cell label="$VIBES OFT PARITY" value={pv.value} color={pv.color} sub={pv.sub} />
        <Cell label="BASE ↔ RH SPREAD" value={p.spreadBps === null ? "n/a" : fmtBps(p.spreadBps)} color={spreadColor} sub={p.spreadBps === null ? undefined : `${p.spreadBps} bps`} />
      </div>
    </div>
  );
}

/** Site-wide 1200×630 card. Live parity telemetry when the RPCs answer; no numbers at all when they don't. */
export async function renderSiteCard(): Promise<ImageResponse> {
  const [parity, fonts] = await Promise.all([within(getBridgeParity({ overnight: false }), 9000), ogFontOption()]);
  return new ImageResponse(
    (
      <Frame>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Wordmark size={28} />
          <span style={{ fontSize: 16, letterSpacing: 4, color: OG.ink3 }}>NIGHT SHIFT SENTINEL</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 34, flex: 1 }}>
          <span style={{ fontFamily: "Serif", fontSize: 84, lineHeight: 1, color: OG.ink }}>Stay asleep.</span>
          <span style={{ fontFamily: "Serif", fontSize: 84, lineHeight: 1, color: OG.phosphor }}>Kestrel watches the chain.</span>
          <span style={{ marginTop: 22, fontSize: 20, color: OG.ink2 }}>
            Overnight risk · liquidity · bridge parity · tranche-escrow sentinel
          </span>
        </div>
        {parity ? (
          <Telemetry p={parity} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <ChainPill chainId={8453} />
            <ChainPill chainId={4663} />
            <span style={{ marginLeft: 8, fontSize: 17, color: OG.ink3, letterSpacing: 2 }}>LIVE RPC TELEMETRY · ZERO MOCK DATA</span>
          </div>
        )}
      </Frame>
    ),
    { ...OG_SIZE, fonts }
  );
}
