import React from "react";
import { AbsoluteFill } from "remotion";
import { C, mono, sans, serif } from "./theme";
import { NightEye, Watch } from "./ui/Watch";

/** YouTube thumbnail: big words, the night-watch dial as the hero, the Night Eye lockup. Readable small. */
export const Poster: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, color: C.ink, overflow: "hidden" }}>
    <AbsoluteFill style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)", backgroundSize: "64px 64px" }} />
    <AbsoluteFill style={{ background: "radial-gradient(42% 60% at 76% 50%, rgba(145,217,130,0.16), transparent 70%)" }} />
    <Watch x={1450} y={540} r={430} p={1} phase={40} speed={0} eye={1} blips={[
      { angle: 38 * 6, color: C.warn, at: -100 }, { angle: 17 * 6, color: C.warn, at: -100 }, { angle: 55 * 6, color: C.warn, at: -100 },
    ]} />
    <div style={{ position: "absolute", left: 96, top: 84, display: "flex", alignItems: "center", gap: 22 }}>
      <NightEye size={92} />
      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 64, letterSpacing: "0.06em" }}>KESTREL</div>
    </div>
    <div style={{ position: "absolute", left: 90, top: 250, fontFamily: sans, fontWeight: 800, fontSize: 210, letterSpacing: "-0.05em", lineHeight: 0.92 }}>
      Stay<br /><span style={{ fontFamily: serif, fontStyle: "italic", fontWeight: 400, color: C.phos, fontSize: 250, letterSpacing: "-0.02em" }}>asleep.</span>
    </div>
    <div style={{ position: "absolute", left: 96, top: 770, display: "flex", alignItems: "center", gap: 18, fontFamily: mono, fontWeight: 700, fontSize: 52 }}>
      <span style={{ color: C.crit }}>3 UNLIMITED</span><span style={{ color: C.ink3 }}>→</span><span style={{ color: C.phos }}>0</span><span style={{ color: C.ink2 }}>IN 32 S</span>
    </div>
    <div style={{ position: "absolute", left: 96, top: 870, fontFamily: mono, fontSize: 30, letterSpacing: "0.14em", color: C.ink2 }}>
      BASE · ROBINHOOD CHAIN · OVERNIGHT SENTINEL
    </div>
  </AbsoluteFill>
);
