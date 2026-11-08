import React from "react";
import { interpolate } from "remotion";
import { C, mono } from "../theme";
import { clamp, expo } from "../ui/motion";
import { NightEye } from "../ui/Watch";
import { Words } from "../ui/Words";
import { Fill, Head, useCue } from "./common";

/** Full-bleed phosphor: what others do after the fact, and what Kestrel does while you sleep. */
export const Different: React.FC = () => {
  const { f, rel } = useCue("different");
  const tK = rel("Kestrel");
  const dim = interpolate(f, [tK - 8, tK + 6], [1, 0.32], clamp);
  const verbs = [
    { t: "watches", at: rel("watches,") },
    { t: "warns", at: rel("warns,") },
    { t: "gets you out", at: rel("gets") },
  ];
  const DARK = "#1F5A17";
  return (
    <Fill bg={C.phos} color={C.paperInk}>
      <div style={{ position: "absolute", left: 120, top: 120, opacity: dim }}>
        <div style={{ fontFamily: mono, fontSize: 18, letterSpacing: "0.18em", marginBottom: 14, opacity: interpolate(f, [0, 10], [0, 0.6], clamp) }}>OTHERS</div>
        <Head size={68}><Words text="Revoke tools clean up after you wake." at={rel("Revoke")} every={3} accent={{ "wake.": DARK }} /></Head>
        <Head size={68} style={{ marginTop: 10 }}><Words text="Alert bots tell you what already happened." at={rel("Alert")} every={3} accent={{ "already": DARK }} /></Head>
      </div>
      <div style={{ position: "absolute", left: 120, top: 520, display: "flex", alignItems: "center", gap: 28, opacity: interpolate(f, [tK - 6, tK + 6], [0, 1], clamp) }}>
        <NightEye size={110} color={C.paperInk} hole={C.phos} open={interpolate(f, [tK - 2, tK + 10], [0, 1], { ...clamp, easing: expo })} />
        <div style={{ fontFamily: mono, fontWeight: 700, fontSize: 72, letterSpacing: "0.04em" }}>KESTREL</div>
      </div>
      <div style={{ position: "absolute", left: 120, top: 680, display: "flex", gap: 22 }}>
        {verbs.map((v) => {
          const p = interpolate(f, [v.at - 3, v.at + 10], [0, 1], { ...clamp, easing: expo });
          return <div key={v.t} style={{ opacity: p, transform: `translateY(${(1 - p) * 30}px)`, background: C.paperInk, color: C.phos, fontFamily: mono, fontWeight: 500, fontSize: 52, padding: "16px 30px", borderRadius: 4 }}>{v.t}</div>;
        })}
      </div>
      <div style={{ position: "absolute", left: 120, top: 830 }}>
        <Head size={92}><Words text="while you sleep." at={rel("while")} every={4} accent={{ "sleep.": DARK }} /></Head>
      </div>
    </Fill>
  );
};
