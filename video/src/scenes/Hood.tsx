import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { evolvePath } from "@remotion/paths";
import { C, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Browser } from "../ui/Footage";
import { Watch } from "../ui/Watch";
import { Words } from "../ui/Words";
import { Fill, Grid, Head, useCue } from "./common";

/** Under the hood: no indexer, no mock data; public nodes in, every number out with its block and an explorer link. */
export const Hood: React.FC = () => {
  const { f, rel } = useCue("hood");
  const tIdx = rel("indexer");
  const tMock = rel("mock");
  const tNodes = rel("nodes,");
  const tBlock = rel("block");
  const strike = (at: number) => interpolate(f, [at + 4, at + 14], [0, 1], { ...clamp, easing: expo });
  const nodes = [
    { logo: "logos/Base_lockup_white.svg", url: "mainnet.base.org", c: C.base, y: 470, blend: false },
    { logo: "logos/rh-chain-lockup-white.png", url: "rpc.mainnet.chain.robinhood.com", c: C.rh, y: 690, blend: true },
  ];
  const EX = 760, EY = 640;
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: 90, top: 84 }}>
        <Head size={84}><Words text="Under the hood." at={rel("Under")} every={4} accent={{ "hood.": C.phos }} /></Head>
      </div>
      <div style={{ position: "absolute", left: 90, top: 210, display: "flex", gap: 16 }}>
        {[{ t: "INDEXER", at: tIdx }, { t: "MOCK DATA", at: tMock }].map((x) => (
          <div key={x.t} style={{ position: "relative", opacity: interpolate(f, [x.at - 4, x.at + 4], [0, 1], clamp), fontFamily: mono, fontSize: 24, letterSpacing: "0.14em", color: C.ink2, border: "1px solid rgba(255,255,255,0.2)", padding: "10px 18px", borderRadius: 4 }}>
            {x.t}
            <div style={{ position: "absolute", left: -6, right: -6, top: "50%", height: 3, background: C.crit, transform: `scaleX(${strike(x.at)})`, transformOrigin: "0 50%" }} />
          </div>
        ))}
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
        {nodes.map((n, i) => {
          const d = `M 560 ${n.y + 40} C 660 ${n.y + 40}, 640 ${EY}, ${EX - 70} ${EY}`;
          const ev = evolvePath(Math.max(0.0001, interpolate(f, [tNodes - 10 + i * 4, tNodes + 14 + i * 4], [0, 1], clamp)), d);
          return <path key={i} d={d} fill="none" stroke={n.c} strokeWidth={2.5} strokeDasharray={ev.strokeDasharray} strokeDashoffset={ev.strokeDashoffset} />;
        })}
      </svg>
      {nodes.map((n, i) => (
        <div key={i} style={{ position: "absolute", left: 90, top: n.y, width: 470, padding: "18px 22px", background: C.surface, borderLeft: `3px solid ${n.c}`, boxShadow: "0 0 0 1px rgba(255,255,255,0.08)", opacity: interpolate(f, [tNodes - 16 + i * 4, tNodes - 4 + i * 4], [0, 1], clamp) }}>
          <Img src={staticFile(n.logo)} style={{ height: 28, mixBlendMode: n.blend ? "screen" : undefined }} />
          <div style={{ marginTop: 10, fontFamily: mono, fontSize: 17, color: C.ink2 }}>{n.url}</div>
        </div>
      ))}
      <Watch x={EX} y={EY} r={78} p={interpolate(f, [tNodes, tNodes + 14], [0, 1], clamp)} speed={6} eye={1} />
      <Browser name="hero" url="usekestrel.vercel.app · live Sentinel Watch" width={940} left={900} top={250} startFrom={20} stopAt={200} cams={[
        { f: 0, rect: { x: 820, y: 113, w: 644, h: 520 }, z: 1.6 },
        { f: tBlock - 10, rect: { x: 820, y: 620, w: 644, h: 270 }, z: 2.4 },
      ]} />
    </Fill>
  );
};
