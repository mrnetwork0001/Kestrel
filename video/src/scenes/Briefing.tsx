import React from "react";
import { Sequence, interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp } from "../ui/motion";
import { Browser, Shot, syncTo } from "../ui/Footage";
import { Count } from "../ui/Count";
import { Words } from "../ui/Words";
import { Fill, Grid, Head, Label, useCue } from "./common";

/** The live briefing: paste an address on the production site, scored in under a second; then the 6:55 wallet at 45. */
export const Briefing: React.FC = () => {
  const { f, rel, dur } = useCue("briefing");
  const tPaste = rel("Paste");
  const tThat = rel("That");
  const t45 = rel("forty-five");
  const tThree = rel("Three");
  const start = syncTo("hero", "hero.pasted", tPaste + 10);
  const res = 372 - start; // hero.result, scene-local
  const W = 1360, L = 280, TOP = 205;
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: L, top: 78 }}>
        <Head size={78}><Words text="Any address." at={tPaste} every={4} /> <Words text="No wallet." at={rel("No")} every={4} accent={{ "wallet.": C.phos }} /></Head>
      </div>
      <Sequence from={0} durationInFrames={tThat + 10} layout="none">
        <Browser name="hero" url="usekestrel.vercel.app" width={W} left={L} top={TOP} startFrom={start} cams={[
          { f: 0, rect: { x: 130, y: 330, w: 760, h: 280 }, z: 1.5 },
          { f: res - 14, rect: { x: 130, y: 330, w: 760, h: 280 }, z: 1.5 },
          { f: res + 40, rect: { x: 100, y: 230, w: 1400, h: 260 }, z: 1.08 },
          { f: res + 150, rect: { x: 560, y: 235, w: 920, h: 250 }, z: 1.35 },
        ]} />
      </Sequence>
      <Sequence from={tThat - 6} durationInFrames={tThree - tThat + 14} layout="none">
        <Shot src="footage/owner/rescue-connected-top.png" iw={2944} ih={1592} url="usekestrel.vercel.app/rescue?target=0xCd0a…3c02" width={W} height={765} left={L} top={TOP} tag="owner capture · 07:04 UTC" cams={[
          { f: 0, rect: { x: 60, y: 40, w: 2860, h: 1500 } },
          { f: t45 - tThat - 4, rect: { x: 60, y: 40, w: 2860, h: 1500 } },
          { f: t45 - tThat + 16, rect: { x: 2100, y: 40, w: 780, h: 420 } },
        ]} />
      </Sequence>
      <Sequence from={tThree - 8} layout="none">
        <Shot src="footage/owner/rescue-connected-steps.png" iw={2930} ih={1592} url="usekestrel.vercel.app/rescue?target=0xCd0a…3c02" width={W} height={765} left={L} top={TOP} tag="owner capture · 07:04 UTC" cams={[
          { f: 0, rect: { x: 120, y: 0, w: 1800, h: 470 } },
          { f: 60, rect: { x: 120, y: 30, w: 1800, h: 440 } },
        ]} />
      </Sequence>
      <div style={{ position: "absolute", left: L + W - 360, top: 96, width: 360, textAlign: "right", opacity: interpolate(f, [t45 - 4, t45 + 8, dur - 4, dur], [0, 1, 1, 1], clamp) }}>
        <div style={{ fontFamily: mono, fontSize: 92, lineHeight: 1, color: C.warn, fontVariantNumeric: "tabular-nums" }}><Count to={45} at={t45 - 2} dur={20} /><span style={{ fontSize: 30, color: C.ink3 }}> / 100</span></div>
      </div>
      <div style={{ position: "absolute", left: L, top: 163, opacity: interpolate(f, [tThat, tThat + 10], [0, 1], clamp) }}>
        <Label>The owner's own capture of the live rescue page · block 54,655,460</Label>
      </div>
    </Fill>
  );
};
