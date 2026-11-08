import React from "react";
import { Sequence, interpolate } from "remotion";
import { C, mono, sans } from "../theme";
import { clamp, expo, pop } from "../ui/motion";
import { Browser, clip, markOf, syncTo } from "../ui/Footage";
import { Count } from "../ui/Count";
import { Words } from "../ui/Words";
import { Card, Fill, Grid, Head, LIVE, X402, blockStr, hms, short, useCue } from "./common";

/** AI agents: ALLOW / WARN / BLOCK, a free preview, the HTTP 402, the first real x402 payment, and the MCP server. */
export const Agents: React.FC = () => {
  const { f, rel } = useCue("agents");
  const tFree = rel("free.");
  const tFirst = rel("first");
  const t725 = rel("twenty-five.");
  const tMcp = rel("MCP");
  const tEleven = rel("eleven");
  const verdicts = [
    { v: "ALLOW", c: C.phos, at: rel("Allow,") },
    { v: "WARN", c: C.warn, at: rel("warn") },
    { v: "BLOCK", c: C.crit, at: rel("block.") },
  ];
  const usdc = X402.events.find((e) => e.token === "USDC");
  const R = { left: 800, top: 200, width: 1040 };
  const hasScan = !!clip("scan_x402");
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 90, top: 84, width: 680 }}>
        <Head size={76}><Words text="Agents ask Kestrel before they swap." at={rel("agents")} every={3} accent={{ "swap.": C.phos }} /></Head>
      </div>
      <div style={{ position: "absolute", left: 90, top: 290, display: "flex", gap: 14 }}>
        {verdicts.map((v) => {
          const p = pop(f, v.at - 2);
          return (
            <div key={v.v} style={{ opacity: interpolate(f, [v.at - 2, v.at + 4], [0, 1], clamp), transform: `scale(${0.7 + 0.3 * p})`, fontFamily: mono, fontWeight: 700, fontSize: 30, letterSpacing: "0.14em", color: v.c, border: `2px solid ${v.c}`, padding: "10px 20px", borderRadius: 4, background: `${v.c}14` }}>{v.v}</div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 90, top: 380, fontFamily: mono, fontSize: 17, letterSpacing: "0.06em", color: C.meta, opacity: interpolate(f, [verdicts[2].at + 4, verdicts[2].at + 16], [0, 1], clamp) }}>
        LIVE: GET /api/v1/guard · $VIBES on Base → <span style={{ color: C.phos }}>{LIVE.guardVibes.verdict}</span> · risk {LIVE.guardVibes.riskScore}
      </div>
      <Card at={tFree - 4} left={90} top={450} width={640} accent={C.phos}>
        <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.16em", color: C.meta }}>PRICE PER FULL VERDICT</div>
        <div style={{ fontFamily: mono, fontSize: 52, marginTop: 6 }}>0.01 <span style={{ color: C.base, fontSize: 30 }}>USDC · x402 · Base</span></div>
        <div style={{ fontFamily: sans, fontSize: 20, color: C.ink2, marginTop: 6 }}>Preview free. No key, no account: HTTP 402, pay, retry.</div>
      </Card>
      <Card at={tFirst - 4} left={90} top={660} width={640} accent={C.base}>
        <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.16em", color: C.meta }}>FIRST PAID CALL · SETTLED ON BASE</div>
        <div style={{ fontFamily: mono, fontSize: 44, marginTop: 6 }}>{hms(X402.utc)} <span style={{ fontSize: 24, color: C.meta }}>UTC</span></div>
        <div style={{ fontFamily: mono, fontSize: 16, color: C.ink2, marginTop: 8, lineHeight: 1.6 }}>
          {usdc?.amount} USDC · block {blockStr(X402.block)}<br /><span style={{ color: C.base }}>{short(X402.hash)}</span>
        </div>
      </Card>
      <Sequence from={0} durationInFrames={tFirst + 6} layout="none">
        <Browser name="agents" url="usekestrel.vercel.app/agents · x402 playground" width={R.width} left={R.left} top={R.top} startFrom={syncTo("agents", "agents.free", tFree)} stopAt={markOf("agents", "agents.ledger") - 4} cams={[
          { f: 0, rect: { x: 100, y: 95, w: 1400, h: 600 }, z: 1.0 },
          { f: tFree - 8, rect: { x: 474, y: 26, w: 990, h: 640 }, z: 1.45 },
          { f: tFree + 120, rect: { x: 474, y: 300, w: 990, h: 640 }, z: 1.45 },
        ]} />
      </Sequence>
      <Sequence from={tFirst - 6} durationInFrames={tMcp - tFirst + 10} layout="none">
        {hasScan ? (
          <Browser name="scan_x402" url={`basescan.org/tx/${short(X402.hash)}`} width={R.width} left={R.left} top={R.top} cams={[{ f: 0, rect: { x: 40, y: 0, w: 1100, h: 620 }, z: 1.4 }, { f: 80, rect: { x: 40, y: 380, w: 1100, h: 420 }, z: 1.4 }]} />
        ) : (
          <Browser name="agents" url="usekestrel.vercel.app/agents · revenue ledger" width={R.width} left={R.left} top={R.top} startFrom={markOf("agents", "agents.ledger") + 40} cams={[{ f: 0, rect: { x: 474, y: 23, w: 990, h: 577 }, z: 1.5 }]} />
        )}
      </Sequence>
      <Sequence from={tMcp - 8} layout="none">
        <Browser name="agents" url="usekestrel.vercel.app/agents · MCP" width={R.width} left={R.left} top={R.top} startFrom={markOf("agents", "agents.mcp") + 40} cams={[{ f: 0, rect: { x: 474, y: 23, w: 990, h: 600 }, z: 1.45 }, { f: 90, rect: { x: 474, y: 260, w: 990, h: 600 }, z: 1.45 }]} />
      </Sequence>
      <div style={{ position: "absolute", left: R.left + R.width - 330, top: R.top + 600, width: 330, padding: "18px 22px", background: C.phos, color: C.bg, borderRadius: 4, opacity: interpolate(f, [tEleven - 4, tEleven + 6], [0, 1], clamp), transform: `translateY(${(1 - interpolate(f, [tEleven - 4, tEleven + 14], [0, 1], { ...clamp, easing: expo })) * 20}px)` }}>
        <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.16em" }}>POST /api/mcp</div>
        <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 56, lineHeight: 1.05 }}><Count to={11} at={tEleven - 2} dur={16} /> tools</div>
      </div>
      <div style={{ position: "absolute", left: R.left, top: R.top - 40, fontFamily: mono, fontSize: 15, letterSpacing: "0.12em", color: C.meta, opacity: interpolate(f, [t725 - 6, t725 + 6, tMcp - 12, tMcp - 4], [0, 1, 1, 0], clamp) }}>
        THE REAL SETTLEMENT · PAYER = THE DEMO WALLET · RECEIVER 0xEbB9…C426
      </div>
    </Fill>
  );
};
