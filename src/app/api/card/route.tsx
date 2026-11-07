import { ImageResponse } from "next/og";
import { NextResponse, type NextRequest } from "next/server";
import { parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";
import type { ChainId, Finding, ScanResult, Severity } from "@/lib/engine/types";
import { fmtUtc, shortAddr } from "@/lib/format";
import { BAND_COLOR, ChainPill, clip, Dot, Frame, OG, OG_SIZE, Wordmark, ogFontOption, within } from "@/lib/og";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEV_RANK: Record<Severity, number> = { critical: 2, warn: 1, info: 0 };
const SEV_TAG: Record<Severity, { label: string; color: string }> = {
  critical: { label: "CRIT", color: OG.crit },
  warn: { label: "WARN", color: OG.warn },
  info: { label: "INFO", color: OG.ink3 },
};

function topFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.points - a.points).slice(0, 3);
}

function ThreatCard({ scan }: { scan: ScanResult }) {
  const t = scan.target;
  const band = BAND_COLOR[scan.band];
  const findings = topFindings(scan.findings);
  return (
    <Frame>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Wordmark size={24} />
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ChainPill chainId={t.chainId} size={16} />
          <span style={{ fontSize: 17, color: OG.ink2 }}>{`BLOCK #${BigInt(scan.block.number).toLocaleString("en-US")}`}</span>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, marginTop: 34, gap: 48 }}>
        {/* verdict */}
        <div style={{ display: "flex", flexDirection: "column", width: 500 }}>
          <span style={{ fontSize: 15, letterSpacing: 3, color: OG.ink3 }}>[ OVERNIGHT THREAT CARD ]</span>
          <span style={{ marginTop: 14, fontFamily: "Serif", fontSize: 50, lineHeight: 1.05, color: OG.ink }}>{clip(t.label || shortAddr(t.address), 36)}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, fontSize: 16 }}>
            <span style={{ border: `1px solid ${OG.hairStrong}`, borderRadius: 2, padding: "3px 8px", letterSpacing: 2, color: OG.ink2 }}>{t.kind.toUpperCase()}</span>
            <span style={{ color: OG.ink3 }}>{shortAddr(t.address, 6)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginTop: "auto" }}>
            <span style={{ fontSize: 150, lineHeight: 0.9, fontWeight: 700, color: band }}>{String(scan.score)}</span>
            <span style={{ fontSize: 24, color: OG.ink3, marginBottom: 10 }}>/ 100</span>
          </div>
          <div style={{ display: "flex", position: "relative", marginTop: 20, height: 8, width: "100%", background: "rgba(255,255,255,0.06)" }}>
            <div style={{ display: "flex", position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(2, Math.min(100, scan.score))}%`, background: band }} />
            <div style={{ display: "flex", position: "absolute", left: "30%", top: -4, bottom: -4, width: 1, background: "rgba(255,255,255,0.3)" }} />
            <div style={{ display: "flex", position: "absolute", left: "65%", top: -4, bottom: -4, width: 1, background: "rgba(255,255,255,0.3)" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, fontSize: 20, letterSpacing: 3, color: band }}>
            <Dot color={band} size={11} />
            {scan.band}
          </div>
        </div>

        {/* evidence */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, borderLeft: `1px solid ${OG.hair}`, paddingLeft: 40 }}>
          <span style={{ fontSize: 15, letterSpacing: 3, color: OG.ink3 }}>{`[ TOP FINDINGS · ${scan.findings.length} TOTAL ]`}</span>
          {findings.length === 0 ? (
            <span style={{ marginTop: 24, fontSize: 22, color: OG.ink2 }}>No findings at this block.</span>
          ) : (
            findings.map((f) => (
              <div key={f.id} style={{ display: "flex", gap: 16, marginTop: 22, paddingBottom: 18, borderBottom: `1px solid ${OG.hair}` }}>
                <span style={{ width: 62, flexShrink: 0, fontSize: 16, letterSpacing: 1, color: SEV_TAG[f.severity].color, marginTop: 4 }}>{SEV_TAG[f.severity].label}</span>
                <span style={{ flex: 1, fontFamily: "Serif", fontSize: 30, lineHeight: 1.15, color: OG.ink }}>{clip(f.title, 70)}</span>
                <span style={{ fontSize: 16, color: OG.ink3, marginTop: 6 }}>{`+${f.points}`}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 26, fontSize: 15, letterSpacing: 2, color: OG.ink3 }}>
        <span>{`LIVE RPC · ${fmtUtc(scan.block.timestamp)}`}</span>
        <span style={{ color: OG.ink2 }}>Stay asleep. Kestrel watches the chain.</span>
      </div>
    </Frame>
  );
}

function UnavailableCard({ chainId, address }: { chainId: ChainId; address: string }) {
  return (
    <Frame>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Wordmark size={24} />
        <ChainPill chainId={chainId} size={16} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
        <span style={{ fontSize: 15, letterSpacing: 3, color: OG.ink3 }}>[ OVERNIGHT THREAT CARD ]</span>
        <span style={{ marginTop: 18, fontFamily: "Serif", fontSize: 64, color: OG.ink }}>Live scan unavailable right now.</span>
        <span style={{ marginTop: 16, fontSize: 22, color: OG.ink2 }}>{`${shortAddr(address, 6)} · open Kestrel to retry the read.`}</span>
      </div>
    </Frame>
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const address = parseAddress(sp.get("target"));
  const chainRaw = sp.get("chain") ?? "8453";
  if (!address) return NextResponse.json({ error: "target must be a 0x-prefixed 20-byte address" }, { status: 400 });
  if (chainRaw !== "8453" && chainRaw !== "4663") return NextResponse.json({ error: "chain must be 8453 (Base) or 4663 (Robinhood Chain)" }, { status: 400 });
  const chainId = Number(chainRaw) as ChainId;

  const [scan, fonts] = await Promise.all([within(scanTarget(chainId, address, { useLlm: false }), 45_000), ogFontOption()]);
  if (!scan) {
    // Honest failure card, never cached, so a later crawl picks up the real scan.
    return new ImageResponse(<UnavailableCard chainId={chainId} address={address} />, { ...OG_SIZE, fonts, status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return new ImageResponse(<ThreatCard scan={scan} />, {
    ...OG_SIZE,
    fonts,
    headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" },
  });
}
