import React from "react";
import { interpolate } from "remotion";
import { C, mono, sans } from "../theme";
import { clamp, expo, soft } from "../ui/motion";
import { Watch } from "../ui/Watch";
import { Words } from "../ui/Words";
import { APPROVALS, Card, Fill, Grid, Head, In, Kicker, blockStr, hms, short, useCue } from "./common";

/** Cold open: Sunday 06:55 UTC, three unlimited approvals land on Base while the watch sleeps. */
export const Open: React.FC = () => {
  const { f, rel } = useCue("open");
  const rows = [
    { t: APPROVALS.usdc, tok: "USDC", sp: "Permit2", at: rel("USDC") },
    { t: APPROVALS.vibes, tok: "VIBES", sp: "Aerodrome Router", at: rel("VIBES") },
    { t: APPROVALS.weth, tok: "WETH", sp: "Uniswap Universal Router", at: rel("WETH") },
  ];
  const sec = (iso: string) => Number(iso.slice(17, 19));
  const blips = rows.map((r) => ({ angle: sec(r.t.utc) * 6, color: C.warn, at: r.at + 4 }));
  // The clock: 06:55:00 ticking up, then jumping to each approval's real second.
  let clock = `06:55:${String(Math.min(37, Math.floor(f / 8))).padStart(2, "0")}`;
  for (const r of rows) if (f >= r.at) clock = hms(r.t.utc);
  const tNothing = rel("Nothing");
  const calm = interpolate(f, [tNothing - 6, tNothing + 20], [0, 1], { ...clamp, easing: soft });
  const sign = rel("signs");
  return (
    <Fill bg={C.bg}>
      <Grid opacity={0.8} />
      <div style={{ position: "absolute", left: 120, top: 104 }}>
        <In at={4}><Kicker>Sun 2026-11-08 · Base mainnet · wallet {short(APPROVALS.usdc.from, 6, 4)}</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 112, top: 150, fontFamily: mono, fontWeight: 500, fontSize: 168, letterSpacing: "-0.04em", color: C.ink, fontVariantNumeric: "tabular-nums", opacity: interpolate(f, [0, 14], [0, 1], clamp) }}>
        {clock}<span style={{ fontSize: 44, color: C.meta, marginLeft: 18, letterSpacing: "0.1em" }}>UTC</span>
      </div>
      <div style={{ position: "absolute", left: 120, top: 360, fontFamily: sans, fontSize: 30, color: C.ink2, opacity: interpolate(f, [sign - 4, sign + 10], [0, 1], clamp) }}>
        One wallet signs <span style={{ color: C.warn }}>three unlimited approvals.</span>
      </div>
      {rows.map((r, i) => {
        const ev = r.t.events[0];
        return (
          <Card key={i} at={r.at - 3} left={120} top={430 + i * 128} width={820} accent={C.warn} style={{ padding: "18px 24px", opacity: 1 - calm * 0.35 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontFamily: mono, fontSize: 30, letterSpacing: "0.02em" }}>
                {r.tok} <span style={{ color: C.ink3 }}>→</span> {r.sp}
              </div>
              <div style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.14em", color: C.crit }}>{ev.amount.toUpperCase()}</div>
            </div>
            <div style={{ marginTop: 8, fontFamily: mono, fontSize: 16, letterSpacing: "0.06em", color: C.meta }}>
              {hms(r.t.utc)} UTC · BLOCK {blockStr(r.t.block)} · <span style={{ color: C.base }}>{short(r.t.hash)}</span>
            </div>
          </Card>
        );
      })}
      <Watch x={1430} y={520} r={320} p={interpolate(f, [0, 30], [0, 1], { ...clamp, easing: expo })} speed={1.6} phase={200} blips={blips} eye={0.06} color={C.phos} />
      <div style={{ position: "absolute", left: 1430 - 200, width: 400, top: 880, textAlign: "center", fontFamily: mono, fontSize: 15, letterSpacing: "0.2em", color: C.meta, opacity: interpolate(f, [20, 40], [0, 1], clamp) }}>
        NO ONE IS WATCHING
      </div>
      <div style={{ position: "absolute", left: 120, top: 860, color: C.ink, opacity: calm }}>
        <Head size={92}><Words text="Nothing looks wrong." at={tNothing} every={4} accent={{ "wrong.": C.phos }} /></Head>
      </div>
    </Fill>
  );
};
