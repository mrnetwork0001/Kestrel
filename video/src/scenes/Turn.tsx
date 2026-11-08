import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { NightEye, Watch } from "../ui/Watch";
import { Words } from "../ui/Words";
import { Fill, Head, useCue } from "./common";

/** Full-bleed phosphor: the watch wakes, the Night Eye opens on "Kestrel", and the tagline. */
export const Turn: React.FC = () => {
  const { f, rel } = useCue("turn");
  const tName = rel("Kestrel.");
  const tStay = rel("Stay");
  const draw = interpolate(f, [tName - 14, tName + 6], [0, 1], { ...clamp, easing: expo });
  const open = interpolate(f, [tName - 2, tName + 12], [0, 1], { ...clamp, easing: expo });
  const word = interpolate(f, [tName + 2, tName + 22], [0, 1], { ...clamp, easing: expo });
  const ring = interpolate(f, [tName - 2, tName + 40], [0, 1], clamp);
  const lift = interpolate(f, [tStay - 8, tStay + 12], [0, 1], { ...clamp, easing: expo });
  const cy = 430 - lift * 90;
  const EYE_X = 960 - 466 + 110; // the eye's centre in the centred lockup (220 mark + 40 gap + ~672 wordmark)
  return (
    <Fill bg={C.phos} color={C.paperInk}>
      <Watch x={EYE_X} y={cy} r={190} p={interpolate(f, [0, 20], [0, 1], clamp)} speed={4} phase={300} eye={0} eyeDraw={0} color={C.paperInk} ink="rgba(7,9,13,0.2)" />
      <div style={{ position: "absolute", left: EYE_X - 500, top: cy - 500, width: 1000, height: 1000, borderRadius: "50%", border: `3px solid rgba(7,9,13,${0.6 * (1 - ring)})`, transform: `scale(${0.2 + ring * 1.4})` }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: cy - 110, display: "flex", justifyContent: "center", alignItems: "center", gap: 40 }}>
        <NightEye size={220} draw={draw} open={open} color={C.paperInk} hole={C.phos} />
        <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 150, letterSpacing: "0.04em", opacity: word, clipPath: `inset(0 ${(1 - word) * 100}% 0 0)` }}>KESTREL</div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 690, textAlign: "center" }}>
        <Head size={104}>
          <Words text="Stay asleep." at={tStay} every={4} />
          <Words text="Kestrel watches the chain." at={rel("Kestrel", 1)} every={3} accent={{ kestrel: "#1F5A17" }} />
        </Head>
      </div>
    </Fill>
  );
};
