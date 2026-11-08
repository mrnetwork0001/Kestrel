import React from "react";
import { Img, interpolate, random, staticFile } from "remotion";
import { evolvePath } from "@remotion/paths";
import { C, mono, sans } from "../theme";
import { clamp, expo, soft } from "../ui/motion";
import { Count } from "../ui/Count";
import { Fill, Grid, Head, In, Kicker, LIVE, fmt18, useCue } from "./common";

/** Dark: 200 ms blocks, 144,000 a night, and $VIBES living on two chains at once. */
export const Evidence: React.FC = () => {
  const { f, rel } = useCue("evidence");
  const tMs = rel("milliseconds.");
  const tK = rel("forty-four");
  const tVibes = rel("VIBES");
  const tBridge = rel("bridge");
  const left = interpolate(f, [tVibes - 10, tVibes + 10], [1, 0], clamp);
  // The block wall: one square per 1,000 blocks = 144 squares for a night.
  const N = 144, cols = 24;
  const filled = Math.round(interpolate(f, [tK - 10, tK + 40], [0, N], { ...clamp, easing: soft }));
  const two = interpolate(f, [tVibes - 4, tVibes + 18], [0, 1], { ...clamp, easing: expo });
  const arc = interpolate(f, [tBridge - 30, tBridge + 4], [0, 1], { ...clamp, easing: soft });
  const d = "M 560 560 Q 960 260 1360 560";
  const ev = evolvePath(Math.max(0.0001, arc), d);
  const locked = fmt18(LIVE.parity.lockedOnBase, 2);
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", inset: 0, opacity: left }}>
        <div style={{ position: "absolute", left: 120, top: 130 }}><In at={0}><Kicker dot={C.base}>Base mainnet · live rate 5.0 blk/s on the Sentinel Watch</Kicker></In></div>
        <div style={{ position: "absolute", left: 110, top: 170, display: "flex", alignItems: "baseline", gap: 18 }}>
          <span style={{ fontFamily: sans, fontSize: 52, color: C.ink2 }}>one block every</span>
        </div>
        <div style={{ position: "absolute", left: 104, top: 220, fontFamily: mono, fontWeight: 500, fontSize: 260, letterSpacing: "-0.05em", color: C.base, lineHeight: 1 }}>
          <Count to={200} at={rel("two") - 6} dur={30} /><span style={{ fontSize: 96, marginLeft: 14, color: C.ink }}>ms</span>
        </div>
        <div style={{ position: "absolute", left: 120, top: 560, opacity: interpolate(f, [tK - 18, tK - 6], [0, 1], clamp) }}>
          <div style={{ fontFamily: mono, fontSize: 22, letterSpacing: "0.1em", color: C.meta }}>8 H × 3,600 S × 5 BLOCKS A SECOND (200 MS)</div>
          <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 132, letterSpacing: "-0.04em", lineHeight: 1.05, marginTop: 6 }}>
            <Count to={144000} at={tK - 16} dur={16} />
          </div>
          <Head size={64} style={{ color: C.ink2 }}>blocks while you <span style={{ fontStyle: "italic", color: C.phos }}>sleep.</span></Head>
        </div>
        <div style={{ position: "absolute", left: 1060, top: 250, display: "grid", gridTemplateColumns: `repeat(${cols}, 26px)`, gap: 6 }}>
          {Array.from({ length: N }, (_, i) => (
            <div key={i} style={{ width: 26, height: 26, borderRadius: 2, background: i < filled ? (random(`b${i}`) > 0.93 ? C.warn : C.base) : "rgba(255,255,255,0.06)", opacity: i < filled ? 0.55 + 0.45 * random(`o${i}`) : 1 }} />
          ))}
        </div>
        <div style={{ position: "absolute", left: 1060, top: 470, fontFamily: mono, fontSize: 16, letterSpacing: "0.12em", color: C.meta, opacity: interpolate(f, [tK, tK + 20], [0, 1], clamp) }}>
          ONE SQUARE = 1,000 BLOCKS
        </div>
      </div>
      <div style={{ position: "absolute", inset: 0, opacity: two }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 140, textAlign: "center" }}>
          <Head size={96}>$VIBES lives on <span style={{ fontStyle: "italic", color: C.phos }}>two chains.</span></Head>
        </div>
        <div style={{ position: "absolute", left: 300, top: 600, width: 520, display: "flex", justifyContent: "center" }}>
          <Img src={staticFile("logos/Base_lockup_white.svg")} style={{ height: 82 }} />
        </div>
        <div style={{ position: "absolute", left: 1100, top: 598, width: 520, display: "flex", justifyContent: "center" }}>
          <Img src={staticFile("logos/rh-chain-lockup-white.png")} style={{ height: 82, mixBlendMode: "screen" }} />
        </div>
        <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
          <path d={d} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={2} strokeDasharray="4 10" />
          <path d={d} fill="none" stroke={C.phos} strokeWidth={3} strokeDasharray={ev.strokeDasharray} strokeDashoffset={ev.strokeDashoffset} style={{ filter: `drop-shadow(0 0 10px ${C.phos})` }} />
          <circle cx={560} cy={560} r={8} fill={C.base} />
          <circle cx={1360} cy={560} r={8 * (arc > 0.98 ? 1 : 0)} fill={C.rh} />
        </svg>
        <div style={{ position: "absolute", left: 0, right: 0, top: 360, textAlign: "center", opacity: interpolate(f, [tBridge - 10, tBridge + 8], [0, 1], clamp) }}>
          <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.16em", color: C.meta }}>LAYERZERO OFT BRIDGE · LOCKED ON BASE</div>
          <div style={{ fontFamily: mono, fontSize: 46, marginTop: 8, color: C.ink }}>{locked} <span style={{ color: C.phos }}>VIBES</span></div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 780, textAlign: "center", fontFamily: mono, fontSize: 16, letterSpacing: "0.12em", color: C.meta }}>
          READ LIVE {LIVE.readAtUtc.slice(0, 16).replace("T", " ")} UTC · BASE #{Number(LIVE.parity.baseBlock).toLocaleString("en-US")} · ROBINHOOD #{Number(LIVE.parity.rhBlock).toLocaleString("en-US")}
        </div>
      </div>
    </Fill>
  );
};
