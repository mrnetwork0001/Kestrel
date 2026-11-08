import React from "react";
import { Img, Sequence, interpolate, staticFile } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Browser, clip, syncTo } from "../ui/Footage";
import { Words } from "../ui/Words";
import { Fill, Grid, Head, Label, LIVE, fmt18, useCue } from "./common";

/** Rug Lab (a labelled simulation on live reserves), then the $VIBES bridge parity, exact to the wei. */
export const Lab: React.FC = () => {
  const { f, rel } = useCue("lab");
  const tWhale = rel("whale");
  const tPulled = rel("pulled");
  const tBridge = rel("bridge");
  const tExact = rel("exact.");
  const start = syncTo("lab", "lab.whale", tWhale - 4);
  const lpAt = 222 - start;
  const W = 1300, L = 310;
  const par = interpolate(f, [tBridge - 10, tBridge + 8], [0, 1], { ...clamp, easing: expo });
  const locked = fmt18(LIVE.parity.lockedOnBase, 2), circ = fmt18(LIVE.parity.rhCirculating, 2);
  const hasParity = !!clip("parity");
  return (
    <Fill bg={C.bg}>
      <Grid />
      <div style={{ position: "absolute", left: L, top: 70, opacity: 1 - par }}>
        <Head size={78}><Words text="Simulate the rug." at={rel("simulate")} every={4} accent={{ "rug.": C.crit }} /></Head>
      </div>
      <div style={{ position: "absolute", left: L + W - 520, top: 98, width: 520, display: "flex", justifyContent: "flex-end", opacity: (1 - par) * interpolate(f, [tWhale - 10, tWhale], [0, 1], clamp) }}>
        <Label>Simulation · exact pool math on live reserves</Label>
      </div>
      <Sequence from={0} durationInFrames={tBridge + 4} layout="none">
        <Browser name="lab" url="usekestrel.vercel.app/app?tab=chaos · Rug Lab" width={W} left={L} top={190} startFrom={start} stopAt={360} cams={[
          { f: 0, rect: { x: 130, y: 60, w: 1340, h: 760 }, z: 1.0 },
          { f: tWhale + 6, rect: { x: 130, y: 100, w: 780, h: 440 }, z: 1.75 },
          { f: lpAt - 6, rect: { x: 130, y: 100, w: 780, h: 440 }, z: 1.75 },
          { f: lpAt + 20, rect: { x: 580, y: 40, w: 900, h: 560 }, z: 1.6 },
        ]} />
      </Sequence>
      <div style={{ position: "absolute", inset: 0, opacity: par }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 86, textAlign: "center" }}>
          <Head size={82}>Locked on Base <span style={{ color: C.ink3 }}>=</span> circulating on <span style={{ fontStyle: "italic", color: C.rh }}>Robinhood.</span></Head>
        </div>
        {hasParity ? (
          <Sequence from={tBridge - 10} layout="none">
            <Browser name="parity" url="usekestrel.vercel.app/app?tab=parity" width={1000} left={460} top={200} cams={[{ f: 0, rect: { x: 130, y: 60, w: 1340, h: 460 }, z: 1.2 }, { f: 130, rect: { x: 130, y: 60, w: 1340, h: 460 }, z: 1.2 }, { f: 175, rect: { x: 130, y: 470, w: 1150, h: 330 }, z: 1.4 }]} />
          </Sequence>
        ) : (
          <>
            {[{ logo: "logos/Base_lockup_white.svg", v: locked, k: "LOCKED IN THE BASE OFT ADAPTER", c: C.base, x: 230, blend: false },
              { logo: "logos/rh-chain-lockup-white.png", v: circ, k: "CIRCULATING ON ROBINHOOD CHAIN", c: C.rh, x: 1000, blend: true }].map((s, i) => (
              <div key={i} style={{ position: "absolute", left: s.x, top: 300, width: 690, padding: "34px 36px", background: C.surface, borderTop: `3px solid ${s.c}`, boxShadow: "0 0 0 1px rgba(255,255,255,0.08)", opacity: interpolate(f, [tBridge + i * 8, tBridge + i * 8 + 12], [0, 1], clamp) }}>
                <Img src={staticFile(s.logo)} style={{ height: 44, mixBlendMode: s.blend ? "screen" : undefined }} />
                <div style={{ marginTop: 26, fontFamily: mono, fontSize: 16, letterSpacing: "0.16em", color: C.meta }}>{s.k}</div>
                <div style={{ marginTop: 10, fontFamily: mono, fontSize: 54, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
                <div style={{ fontFamily: mono, fontSize: 18, color: s.c, marginTop: 4 }}>VIBES</div>
              </div>
            ))}
          </>
        )}
        <div style={{ position: "absolute", left: 0, right: 0, top: hasParity ? 826 : 680, textAlign: "center", opacity: interpolate(f, [tExact - 6, tExact + 6], [0, 1], clamp), transform: `scale(${0.9 + 0.1 * interpolate(f, [tExact - 6, tExact + 14], [0, 1], { ...clamp, easing: expo })})` }}>
          <div style={{ display: "inline-flex", alignItems: "baseline", gap: 26, fontFamily: mono, color: C.phos }}>
            <span style={{ fontSize: 96, lineHeight: 1 }}>Δ {LIVE.parity.delta}</span>
            <span style={{ fontSize: 28, letterSpacing: "0.16em" }}>{LIVE.parity.verdict} · NOT ONE WEI APART</span>
          </div>
          {hasParity ? null : (
            <div style={{ marginTop: 18, fontFamily: mono, fontSize: 16, letterSpacing: "0.1em", color: C.meta }}>
              READ {LIVE.readAtUtc.slice(0, 16).replace("T", " ")} UTC · BASE #{Number(LIVE.parity.baseBlock).toLocaleString("en-US")} · ROBINHOOD #{Number(LIVE.parity.rhBlock).toLocaleString("en-US")}
            </div>
          )}
        </div>
      </div>
    </Fill>
  );
};
