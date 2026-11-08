import React from "react";
import { Img, interpolate, staticFile } from "remotion";
import { C, mono, sans } from "../theme";
import { clamp, expo } from "../ui/motion";
import { Browser, syncTo } from "../ui/Footage";
import { Words } from "../ui/Words";
import { Fill, Head, In, LIVE, fmt18, useCue } from "./common";

/** Light: Backer Shield on the Genesis escrow: the raise, the tranche schedule, the 72-hour challenge window. */
export const Shield: React.FC = () => {
  const { f, rel } = useCue("shield");
  const tGen = rel("Genesis");
  const tCount = rel("counts");
  const t72 = rel("seventy-two");
  const raised = fmt18(LIVE.genesisEscrow.raisedWei, 4);
  const tr = LIVE.genesisEscrow.tranches;
  const paid = tr.filter((t) => t.status === "PAID").length;
  const start = syncTo("shield", "shield.scroll", tCount - 30);
  const win = interpolate(f, [t72 - 6, t72 + 70], [1, 0.72], clamp);
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 100, top: 92 }}>
        <In at={0}>
          <div style={{ display: "inline-flex", alignItems: "center", background: C.bg, padding: "12px 18px", borderRadius: 6 }}>
            <Img src={staticFile("logos/vibestarter-large.png")} style={{ height: 30 }} />
          </div>
        </In>
      </div>
      <div style={{ position: "absolute", left: 100, top: 160 }}>
        <Head size={86}><Words text="Backer Shield." at={rel("Backer")} every={4} accent={{ "shield.": "#2F7A25" }} /></Head>
      </div>
      <div style={{ position: "absolute", left: 100, top: 300, width: 640, opacity: interpolate(f, [tGen - 6, tGen + 8], [0, 1], clamp) }}>
        <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.16em", color: C.paperMuted }}>GENESIS RAISE · 0x0e9b…c911 · BASE</div>
        <div style={{ fontFamily: mono, fontWeight: 500, fontSize: 92, letterSpacing: "-0.03em", lineHeight: 1.05, marginTop: 6 }}>{raised} <span style={{ fontSize: 40 }}>ETH</span></div>
        <div style={{ marginTop: 26, display: "flex", gap: 6 }}>
          {tr.map((t, i) => {
            const p = interpolate(f, [tGen + 10 + i * 4, tGen + 22 + i * 4], [0, 1], { ...clamp, easing: expo });
            const w = i === 0 ? 56 : 84;
            return (
              <div key={i} style={{ width: w }}>
                <div style={{ height: 22, borderRadius: 2, background: t.status === "PAID" ? "#3E8E33" : "rgba(7,9,13,0.12)", transform: `scaleY(${p})`, transformOrigin: "50% 100%" }} />
                <div style={{ marginTop: 8, fontFamily: mono, fontSize: 12, color: C.paperMuted, letterSpacing: "0.04em" }}>{i === 0 ? "KICK" : `M${i}`}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, fontFamily: sans, fontSize: 22, color: C.paperMuted }}>{paid} of {tr.length} tranches paid · 10% kickstart + six 15% tranches</div>
      </div>
      <div style={{ position: "absolute", left: 100, top: 690, display: "flex", alignItems: "center", gap: 28, opacity: interpolate(f, [tCount - 6, tCount + 8], [0, 1], clamp) }}>
        <svg width={120} height={120} viewBox="-60 -60 120 120">
          <circle r={52} fill="none" stroke="rgba(7,9,13,0.12)" strokeWidth={8} />
          <circle r={52} fill="none" stroke={C.warn} strokeWidth={8} strokeDasharray={`${2 * Math.PI * 52 * win} 999`} transform="rotate(-90)" strokeLinecap="round" />
          <text y={9} textAnchor="middle" fontFamily={mono} fontSize={26} fill={C.paperInk}>72h</text>
        </svg>
        <div>
          <div style={{ fontFamily: mono, fontSize: 16, letterSpacing: "0.16em", color: C.paperMuted }}>EACH TRANCHE REQUEST OPENS</div>
          <div style={{ fontFamily: sans, fontWeight: 500, fontSize: 34, letterSpacing: "-0.01em" }}>a 72-hour backer challenge window</div>
        </div>
      </div>
      <Browser name="shield" url="usekestrel.vercel.app/app?tab=shield" width={1000} left={830} top={250} light startFrom={start} cams={[
        { f: 0, rect: { x: 580, y: 60, w: 900, h: 520 }, z: 1.45 },
        { f: tCount - 6, rect: { x: 580, y: 60, w: 900, h: 520 }, z: 1.45 },
        { f: tCount + 40, rect: { x: 580, y: 140, w: 900, h: 420 }, z: 1.5 },
      ]} />
    </Fill>
  );
};
