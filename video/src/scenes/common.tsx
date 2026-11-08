import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { scene, wordAt } from "../timing";
import { C, mono, sans, serif } from "../theme";
import { clamp, expo, pop } from "../ui/motion";
import onchain from "../../data/onchain.json";
import live from "../../data/live.json";

/** Scene-local frame and word cues: rel("word", n) is when the nth "word" is spoken, scene-local. */
export function useCue(id: string) {
  const s = scene(id);
  const f = useCurrentFrame();
  const rel = (w: string, n = 0) => wordAt(id, w, n) - s.from;
  return { s, f, rel, dur: s.durationInFrames };
}

export const Fill: React.FC<{ bg: string; children: React.ReactNode; color?: string }> = ({ bg, children, color = C.ink }) => (
  <AbsoluteFill style={{ background: bg, fontFamily: sans, color, overflow: "hidden" }}>{children}</AbsoluteFill>
);

/** The app's faint terminal grid behind dark scenes. */
export const Grid: React.FC<{ color?: string; size?: number; opacity?: number }> = ({ color = "rgba(255,255,255,0.035)", size = 64, opacity = 1 }) => (
  <AbsoluteFill style={{ opacity, backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`, backgroundSize: `${size}px ${size}px` }} />
);

/** Small mono kicker, the app's TARGET · WALLET style. */
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; dot?: string; size?: number; style?: React.CSSProperties }> = ({ children, color = "rgba(243,246,250,0.6)", dot = C.phos, size = 16, style }) => (
  <div style={{ fontFamily: mono, fontSize: size, letterSpacing: "0.18em", textTransform: "uppercase", color, display: "flex", alignItems: "center", gap: 12, ...style }}>
    <span style={{ width: 8, height: 8, borderRadius: 1, background: dot, boxShadow: `0 0 10px ${dot}` }} />{children}
  </div>
);

/** Fade, rise and un-blur for any block. */
export const In: React.FC<{ at: number; dur?: number; y?: number; x?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, dur = 16, y = 26, x = 0, children, style, out }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: expo });
  const o = out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1;
  return <div style={{ opacity: p * o, transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px)`, filter: p < 1 ? `blur(${(1 - p) * 7}px)` : undefined, ...style }}>{children}</div>;
};

/** A terminal card that pops in at `at`. */
export const Card: React.FC<{ at: number; left: number; top: number; width: number; light?: boolean; accent?: string; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({ at, left, top, width, light, accent = C.phos, children, style, out }) => {
  const f = useCurrentFrame();
  const p = pop(f, at);
  const o = interpolate(f, [at, at + 8], [0, 1], clamp) * (out != null ? interpolate(f, [out, out + 10], [1, 0], clamp) : 1);
  return (
    <div style={{
      position: "absolute", left, top, width, opacity: o, transform: `translateY(${(1 - p) * 28}px) scale(${0.94 + 0.06 * p})`, transformOrigin: "50% 100%",
      background: light ? "rgba(255,255,255,0.92)" : "rgba(12,16,23,0.94)", color: light ? C.paperInk : C.ink, padding: "22px 26px", borderRadius: 6,
      boxShadow: light ? "0 0 0 1px rgba(7,9,13,0.1), 0 26px 60px rgba(7,9,13,0.14)" : "0 0 0 1px rgba(255,255,255,0.1), 0 30px 70px rgba(0,0,0,0.5)",
      borderLeft: `3px solid ${accent}`, fontFamily: sans, ...style,
    }}>{children}</div>
  );
};

/** A big serif headline, the site's Instrument Serif display. */
export const Head: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 96, style }) => (
  <div style={{ fontFamily: serif, fontWeight: 400, fontSize: size, letterSpacing: "-0.02em", lineHeight: 1.02, ...style }}>{children}</div>
);

/** A labelled chip the film puts on anything that is a simulation or someone's own capture. */
export const Label: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = C.warn, style }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 10, fontFamily: mono, fontSize: 15, letterSpacing: "0.14em", textTransform: "uppercase", color, border: `1px solid ${color}88`, background: "rgba(7,9,13,0.75)", padding: "7px 14px", borderRadius: 4, ...style }}>{children}</div>
);

export const short = (h: string, a = 10, b = 6) => `${h.slice(0, a)}…${h.slice(-b)}`;
export const blockStr = (n: number) => n.toLocaleString("en-US");
/** "06:55:38" from an ISO time. */
export const hms = (iso: string) => iso.slice(11, 19);

export interface Ev { type: string; token: string; spenderName?: string | null; amount: string; from?: string; to?: string }
export interface Tx { hash: string; block: number; utc: string; from: string; to: string; nonce: number; status: string; events: Ev[]; explorer: string }
export const TXS = (onchain as unknown as { txs: Tx[] }).txs;
export const tx = (prefix: string): Tx => {
  const t = TXS.find((x) => x.hash.startsWith(prefix));
  if (!t) throw new Error("no tx " + prefix);
  return t;
};
export const WALLET = (onchain as unknown as { wallet: string }).wallet;
export const LIVE = live as unknown as {
  readAtUtc: string;
  parity: { verdict: string; delta: string; lockedOnBase: string; rhCirculating: string; spreadBps: number; baseBlock: string; rhBlock: string };
  genesisEscrow: { raisedWei: string; tranches: { label: string; status: string; amount: string }[] };
  guardVibes: { verdict: string; riskScore: number; band: string };
  pager: { healthy: boolean; cadenceSec: number; scheduler: string; checks: number };
};
/** BigInt-safe 18-decimal formatting to `dp` places, with thousands separators. */
export const fmt18 = (wei: string, dp = 2) => {
  const v = BigInt(wei);
  const scale = 10n ** BigInt(18 - dp);
  const q = (v + scale / 2n) / scale;
  const s = q.toString().padStart(dp + 1, "0");
  const i = s.slice(0, -dp) || "0", d = s.slice(-dp);
  return `${BigInt(i).toLocaleString("en-US")}${dp ? "." + d : ""}`;
};

/** The approvals and the rescue, straight from data/onchain.json. */
export const APPROVALS = { usdc: tx("0xea2c13aa"), vibes: tx("0x22bf1d24"), weth: tx("0x86d4d64f") };
export const RESCUE = [
  { t: tx("0xa3ca5b37"), what: "Revoke WETH → Uniswap Universal Router", fig: "allowance 0" },
  { t: tx("0x24cf9051"), what: "Revoke USDC → Permit2", fig: "allowance 0" },
  { t: tx("0xfca37c8f"), what: "Approve exact VIBES → Aerodrome", fig: "12,358.636 VIBES" },
  { t: tx("0x5d1a02b4"), what: "Swap VIBES → USDC", fig: "12,358.636 VIBES → 1.963096 USDC" },
  { t: tx("0x41ce2c99"), what: "Approve exact WETH → Aerodrome", fig: "0.0015 WETH" },
  { t: tx("0x8752ce32"), what: "Swap WETH → USDC", fig: "0.0015 WETH → 3.346594 USDC" },
];
export const X402 = tx("0xe79c92c1");
