import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Browser, Phone, syncTo } from "../ui/Footage";
import { Words } from "../ui/Words";
import { Fill, Grid, Head, Label, LIVE, useCue } from "./common";

/** The Night-Shift Pager: the public watch log (a check every 4 minutes), a dry run, then the real Telegram page. */
export const Pager: React.FC = () => {
  const { f, rel } = useCue("pager");
  const tEvery = rel("Every");
  const tRules = rel("rules");
  const tTg = rel("Telegram");
  const start = syncTo("pager", "pager.result", tTg - 40);
  const evalAt = 119 - start, resAt = 335 - start;
  const shrink = interpolate(f, [tTg - 16, tTg + 6], [0, 1], { ...clamp, easing: expo });
  const W = 1180 - shrink * 160;
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 90, top: 70 }}>
        <Head size={78}><Words text="Set a watch." at={rel("Set")} every={4} /> <Words text="Go to bed." at={rel("go")} every={4} accent={{ "bed.": C.phos }} /></Head>
      </div>
      <Browser name="pager" url="usekestrel.vercel.app/app?tab=pager" width={W} left={90} top={190} startFrom={start} cams={[
        { f: 0, rect: { x: 136, y: 40, w: 1330, h: 600 }, z: 1.15 },
        { f: tEvery - 6, rect: { x: 1240, y: 20, w: 340, h: 260 }, z: 2.4 },
        { f: evalAt - 20, rect: { x: 1240, y: 20, w: 340, h: 260 }, z: 2.4 },
        { f: evalAt + 10, rect: { x: 130, y: 380, w: 800, h: 500 }, z: 1.75 },
        { f: resAt + 10, rect: { x: 130, y: 600, w: 800, h: 300 }, z: 1.75 },
      ]} />
      <div style={{ position: "absolute", left: 90, top: 190 + (W * 900) / 1600 + 58, opacity: interpolate(f, [tEvery, tEvery + 10], [0, 1], clamp) }}>
        <Label color={C.phos}>Live log · a check every {LIVE.pager.cadenceSec / 60} min via {LIVE.pager.scheduler === "qstash" ? "QStash" : LIVE.pager.scheduler} · Evaluate is a dry run, nothing sent</Label>
      </div>
      <Phone left={1370} top={110} width={420} video="tg" startFrom={20} stopAt={80} enter={tTg - 10} label="Owner's Telegram · @KestrelNightShiftBot" />
    </Fill>
  );
};
