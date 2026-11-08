import React from "react";
import { Sequence, interpolate } from "remotion";
import { C, mono, sans } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Browser, Phone, Shot } from "../ui/Footage";
import { Count } from "../ui/Count";
import { Watch } from "../ui/Watch";
import { Fill, Grid, Kicker, RESCUE, blockStr, hms, short, useCue } from "./common";

/** The owner's real rescue at 07:07 UTC: simulate, six guided signatures, 32 seconds, every allowance back to 0. */
export const Rescue: React.FC = () => {
  const { f, rel, dur } = useCue("rescue");
  const tSim = rel("simulated");
  const tSix = rel("six");
  const tThirty = rel("Thirty-two");
  const tAllow = rel("allowance");
  const tScore = rel("Score:");
  const at = [rel("Two"), rel("revokes."), rel("VIBES"), rel("swapped"), rel("USDC,"), rel("exact-size")];
  let clock = "07:07:05";
  RESCUE.forEach((r, i) => { if (f >= at[i]) clock = hms(r.t.utc); });
  const done = interpolate(f, [tScore - 4, tScore + 16], [0, 1], { ...clamp, easing: expo });
  const PX = 1020;
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 90, top: 72 }}><Kicker dot={C.crit}>Panic Bunker · the owner's own rescue · Base</Kicker></div>
      <div style={{ position: "absolute", left: 82, top: 104, fontFamily: mono, fontWeight: 500, fontSize: 120, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>
        {clock}<span style={{ fontSize: 34, color: C.meta, marginLeft: 14, letterSpacing: "0.1em" }}>UTC</span>
      </div>
      <div style={{ position: "absolute", left: 790, top: 112, opacity: interpolate(f, [tThirty - 4, tThirty + 8], [0, 1], clamp), transform: `scale(${0.9 + 0.1 * interpolate(f, [tThirty - 4, tThirty + 12], [0, 1], { ...clamp, easing: expo })})`, transformOrigin: "0 50%" }}>
        <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.14em", color: C.meta }}>FIRST TO LAST SIGNATURE</div>
        <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 84, color: C.phos, lineHeight: 1 }}><Count to={32} at={tThirty - 2} dur={24} /> s</div>
      </div>
      {RESCUE.map((r, i) => {
        const p = interpolate(f, [at[i] - 4, at[i] + 12], [0, 1], { ...clamp, easing: expo });
        const rev = i < 2;
        return (
          <div key={i} style={{ position: "absolute", left: 90, top: 300 + i * 96, width: 860, opacity: p, transform: `translateX(${(1 - p) * -30}px)`, display: "flex", gap: 22, alignItems: "flex-start" }}>
            <div style={{ width: 40, height: 40, flex: "none", borderRadius: 4, border: `2px solid ${rev ? C.crit : C.phos}`, color: rev ? C.crit : C.phos, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 17 }}>{String(i + 1).padStart(2, "0")}</div>
            <div>
              <div style={{ fontFamily: sans, fontWeight: 500, fontSize: 27, letterSpacing: "-0.01em" }}>{r.what} <span style={{ color: C.ink2, fontSize: 21, fontWeight: 400 }}>· {r.fig}</span></div>
              <div style={{ marginTop: 4, fontFamily: mono, fontSize: 15, letterSpacing: "0.06em", color: C.meta }}>{hms(r.t.utc)} UTC · BLOCK {blockStr(r.t.block)} · <span style={{ color: C.base }}>{short(r.t.hash)}</span> · <span style={{ color: C.phos }}>SUCCESS</span></div>
            </div>
          </div>
        );
      })}
      {/* right panel: the sign rail, the wallet's own notifications, the Pager's RESOLVED pages, then the live page now */}
      <Sequence from={0} durationInFrames={tSix + 10} layout="none">
        <Shot src="footage/owner/rescue-bundle-6calls.png" iw={920} ih={948} url="usekestrel.vercel.app/rescue · sign rail" width={700} height={720} left={PX + 60} top={190} tag="owner capture" cams={[
          { f: 0, rect: { x: 40, y: 20, w: 850, h: 880 } },
          { f: tSim - 6, rect: { x: 40, y: 20, w: 850, h: 880 } },
          { f: tSim + 14, rect: { x: 60, y: 330, w: 800, h: 480 } },
        ]} />
      </Sequence>
      <Sequence from={tSix - 8} durationInFrames={tAllow - tSix + 6} layout="none">
        <Phone left={PX + 210} top={150} width={400} img={{ src: "footage/owner/zerion-rescue-notifications-safe.jpg", w: 857, h: 1280 }} scrollY={0} aspect={1.56} label="Owner's phone · Zerion notifications" />
      </Sequence>
      <Sequence from={tAllow - 10} durationInFrames={tScore - tAllow + 6} layout="none">
        <Phone left={PX + 210} top={150} width={400} video="tg" startFrom={455} stopAt={560} label="Owner's Telegram · RESOLVED pages" />
      </Sequence>
      <Sequence from={tScore - 8} layout="none">
        <Browser name="after" url="usekestrel.vercel.app/rescue?target=0xCd0a…3c02 · live now" width={820} left={PX} top={230} startFrom={95} cams={[
          { f: 0, rect: { x: 1043, y: 80, w: 421, h: 412 }, z: 2.2 },
          { f: 40, rect: { x: 1043, y: 80, w: 421, h: 412 }, z: 2.2 },
          { f: 80, rect: { x: 136, y: 283, w: 875, h: 157 }, z: 1.85 },
        ]} />
      </Sequence>
      <div style={{ position: "absolute", left: 90, top: 880, opacity: done, fontFamily: mono, fontSize: 20, letterSpacing: "0.1em", color: C.phos }}>
        ALL ALLOWANCES 0 · LIVE SCORE 0 / 100 NOMINAL
      </div>
      <Watch x={1780} y={120} r={70} p={1} speed={5} color={done > 0.5 ? C.phos : C.crit} eye={1} />
    </Fill>
  );
};
