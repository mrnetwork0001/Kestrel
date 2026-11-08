import React from "react";
import { interpolate } from "remotion";
import { C, mono, sans } from "../theme";
import { clamp, soft } from "../ui/motion";
import { Words } from "../ui/Words";
import { Card, Fill, Head, useCue } from "./common";

/** Light: the market never closes, people sleep, and the night does its damage. */
export const Problem: React.FC = () => {
  const { f, rel, dur } = useCue("problem");
  const items = [
    { k: "LP", t: "Liquidity gets pulled", at: rel("liquidity") },
    { k: "PROXY", t: "Contracts get upgraded", at: rel("contracts") },
    { k: "ADMIN", t: "Admin keys change", at: rel("admin") },
    { k: "APPROVAL", t: "An old approval gets drained", at: rel("old") },
  ];
  const tBy = rel("By");
  // The night strip: 22:00 to 07:00, swept by the watch line.
  const sweep = interpolate(f, [0, dur], [0.05, 1], { ...clamp, easing: soft });
  const hours = ["22:00", "23:00", "00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"];
  const X0 = 120, X1 = 1800;
  return (
    <Fill bg={C.paper} color={C.paperInk}>
      <div style={{ position: "absolute", left: 120, top: 120 }}>
        <Head size={128}><Words text="Crypto never closes." at={rel("crypto")} every={4} accent={{ "closes.": "#3E8E33" }} /></Head>
        <Head size={128} style={{ marginTop: 6 }}><Words text="People sleep." at={rel("people")} every={4} accent={{ "sleep.": "#3E8E33" }} /></Head>
      </div>
      {items.map((it, i) => (
        <Card key={i} at={it.at - 4} left={120 + i * 425} top={520} width={395} light accent={i === 3 ? C.crit : C.warn} out={tBy - 6} style={{ height: 150 }}>
          <div style={{ fontFamily: mono, fontSize: 15, letterSpacing: "0.18em", color: i === 3 ? C.crit : "#B07400" }}>{it.k}</div>
          <div style={{ marginTop: 12, fontFamily: sans, fontWeight: 500, fontSize: 30, letterSpacing: "-0.01em", lineHeight: 1.15 }}>{it.t}</div>
        </Card>
      ))}
      <div style={{ position: "absolute", left: 120, top: 520, opacity: interpolate(f, [tBy - 4, tBy + 10], [0, 1], clamp) }}>
        <Head size={110}><Words text="By morning, it is history." at={tBy} every={4} accent={{ "history.": C.crit }} /></Head>
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
        <line x1={X0} x2={X1} y1={860} y2={860} stroke="rgba(7,9,13,0.18)" strokeWidth={2} />
        <line x1={X0} x2={X0 + (X1 - X0) * sweep} y1={860} y2={860} stroke={C.paperInk} strokeWidth={3} />
        <circle cx={X0 + (X1 - X0) * sweep} cy={860} r={9} fill={C.paperInk} />
      </svg>
      {hours.map((h, i) => (
        <div key={h} style={{ position: "absolute", left: X0 + ((X1 - X0) * i) / 9 - 40, width: 80, top: 884, textAlign: "center", fontFamily: mono, fontSize: 16, letterSpacing: "0.06em", color: "rgba(7,9,13,0.5)" }}>{h}</div>
      ))}
      <div style={{ position: "absolute", left: X0, top: 812, fontFamily: mono, fontSize: 15, letterSpacing: "0.18em", color: "rgba(7,9,13,0.5)" }}>WHILE YOU SLEEP · UTC</div>
    </Fill>
  );
};
