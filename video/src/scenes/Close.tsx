import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { NightEye, Watch } from "../ui/Watch";
import { Words } from "../ui/Words";
import { Fill, Head, useCue } from "./common";

/** The close: the Night Eye on its watch, the tagline, the live URL and the event. */
export const Close: React.FC = () => {
  const { f, rel, dur } = useCue("close");
  const tName = rel("Kestrel.");
  const tStay = rel("Stay");
  const tBuilt = rel("Built");
  const open = interpolate(f, [tName - 4, tName + 10], [0, 1], { ...clamp, easing: expo });
  const word = interpolate(f, [tName, tName + 20], [0, 1], { ...clamp, easing: expo });
  const foot = interpolate(f, [tBuilt - 6, tBuilt + 10], [0, 1], clamp);
  const out = interpolate(f, [dur - 24, dur], [1, 0], clamp);
  return (
    <Fill bg={C.bg}>
      <div style={{ position: "absolute", inset: 0, opacity: out }}>
        <Watch x={960} y={330} r={250} p={interpolate(f, [0, 20], [0, 1], clamp)} speed={1.5} phase={90} eye={0} eyeDraw={0} />
        <div style={{ position: "absolute", left: 960 - 95, top: 330 - 95 }}>
          <NightEye size={190} open={open} draw={interpolate(f, [0, 16], [0, 1], { ...clamp, easing: expo })} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 610, textAlign: "center", fontFamily: mono, fontWeight: 700, fontSize: 96, letterSpacing: "0.06em", opacity: word, clipPath: `inset(0 ${(1 - word) * 50}% 0 ${(1 - word) * 50}%)` }}>KESTREL</div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 730, textAlign: "center" }}>
          <Head size={70}><Words text="Stay asleep." at={tStay} every={4} /> <Words text="Kestrel watches the chain." at={rel("Kestrel", 1)} every={3} accent={{ kestrel: C.phos }} /></Head>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 840, textAlign: "center", fontFamily: mono, fontSize: 30, color: C.phos, opacity: interpolate(f, [tStay, tStay + 12], [0, 1], clamp) }}>usekestrel.vercel.app</div>
        <div style={{ position: "absolute", left: 120, right: 120, top: 950, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: foot }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, fontFamily: mono, fontSize: 18, letterSpacing: "0.14em", color: C.ink2 }}>
            BUILT FOR <Img src={staticFile("logos/vibestarter-large.png")} style={{ height: 26 }} /> VIBEATHON 02 · NIGHT SHIFT
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
            <Img src={staticFile("logos/Base_lockup_white.svg")} style={{ height: 30 }} />
            <Img src={staticFile("logos/rh-chain-lockup-white.png")} style={{ height: 30, mixBlendMode: "screen" }} />
          </div>
        </div>
      </div>
    </Fill>
  );
};
