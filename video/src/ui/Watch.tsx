import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C } from "../theme";
import { clamp, expo } from "./motion";

/**
 * Kestrel's Night Eye (src/components/logo-mark.tsx, viewBox 0 0 64 64): a crescent moon wrapped around an
 * open raptor eye. `draw` reveals the crescent, `open` opens the eye (0 = a closed lid line, 1 = wide open).
 */
export const NightEye: React.FC<{ size: number; draw?: number; open?: number; color?: string; hole?: string; style?: React.CSSProperties }> = ({ size, draw = 1, open = 1, color = C.phos, hole = C.bg, style }) => {
  const o = Math.max(0.04, open);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ overflow: "visible", ...style }}>
      <defs>
        <clipPath id={`moon-${size}`}>
          <rect x={0} y={0} width={64} height={64 * draw} />
        </clipPath>
      </defs>
      <path d="M40 6 A27 27 0 1 0 58 40 A22 22 0 0 1 40 6 Z" fill={color} clipPath={`url(#moon-${size})`} />
      <g transform={`translate(29 35) scale(1 ${o}) translate(-29 -35)`}>
        <circle cx="29" cy="35" r="10.5" fill={hole} />
        <circle cx="29" cy="35" r="7.5" fill="none" stroke={color} strokeWidth={2.4 / Math.max(0.35, o)} />
        <circle cx="29" cy="35" r="3.2" fill={color} />
      </g>
    </svg>
  );
};

export interface Blip { angle: number; color: string; at: number; label?: string }

/**
 * The film's motif: the night watch. A dial of 60 minute-ticks with a sweep arm that circles like a radar,
 * leaving a fading wedge. Blips (real events, placed by their UTC second: 6 degrees a second) flare
 * when they land and glow on after. The Night Eye sits in the middle.
 */
export const Watch: React.FC<{
  x: number; y: number; r: number; p?: number; speed?: number; phase?: number; blips?: Blip[];
  eye?: number; eyeDraw?: number; color?: string; dim?: number; children?: React.ReactNode; ink?: string; hole?: string;
}> = ({ x, y, r, p = 1, speed = 2.4, phase = 0, blips = [], eye = 0, eyeDraw = 1, color = C.phos, dim = 0, children, ink = "rgba(243,246,250,0.22)", hole = C.bg }) => {
  const f = useCurrentFrame();
  const a = (phase + f * speed) % 360;
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const pt = (d: number, rr: number) => [Math.cos(rad(d)) * rr, Math.sin(rad(d)) * rr];
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  const wedge = (span: number) => {
    const [x1, y1] = pt(a - span, r * 0.96), [x2, y2] = pt(a, r * 0.96);
    return `M 0 0 L ${x1} ${y1} A ${r * 0.96} ${r * 0.96} 0 0 1 ${x2} ${y2} Z`;
  };
  const s = 0.85 + 0.15 * p;
  return (
    <div style={{ position: "absolute", left: x - r, top: y - r, width: r * 2, height: r * 2, opacity: p * (1 - dim * 0.6), transform: `scale(${s})` }}>
      <svg width={r * 2} height={r * 2} viewBox={`${-r} ${-r} ${r * 2} ${r * 2}`} style={{ overflow: "visible", position: "absolute", left: 0, top: 0 }}>
        <defs>
          <radialGradient id={`wg-${r}`} cx="0" cy="0" r={r} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={color} stopOpacity={0} />
            <stop offset="1" stopColor={color} stopOpacity={0.22} />
          </radialGradient>
        </defs>
        <circle r={r} fill="none" stroke={ink} strokeWidth={1.5} />
        <circle r={r * 0.62} fill="none" stroke={ink} strokeWidth={1} strokeDasharray="2 6" />
        {ticks.map((i) => {
          const big = i % 5 === 0;
          const [x1, y1] = pt(i * 6, r - (big ? 22 : 10)), [x2, y2] = pt(i * 6, r - 2);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={big ? "rgba(243,246,250,0.55)" : ink} strokeWidth={big ? 2.5 : 1.5} />;
        })}
        <path d={wedge(55)} fill={`url(#wg-${r})`} opacity={0.9} />
        {(() => { const [x2, y2] = pt(a, r * 0.98); return <line x1={0} y1={0} x2={x2} y2={y2} stroke={color} strokeWidth={2.5} strokeLinecap="round" style={{ filter: `drop-shadow(0 0 8px ${color})` }} />; })()}
        {blips.map((b, i) => {
          const q = interpolate(f, [b.at, b.at + 14], [0, 1], { ...clamp, easing: expo });
          if (q <= 0) return null;
          const [bx, by] = pt(b.angle, r * 0.8);
          const ring = interpolate(f, [b.at, b.at + 30], [0, 1], clamp);
          const pulse = 0.75 + 0.25 * Math.sin((f - b.at) / 6);
          return (
            <g key={i}>
              <circle cx={bx} cy={by} r={8 + ring * 36} fill="none" stroke={b.color} strokeWidth={2} opacity={1 - ring} />
              <circle cx={bx} cy={by} r={9 * q} fill={b.color} opacity={pulse} style={{ filter: `drop-shadow(0 0 12px ${b.color})` }} />
            </g>
          );
        })}
      </svg>
      {eye > 0 || eyeDraw > 0 ? (
        <div style={{ position: "absolute", left: r - r * 0.34, top: r - r * 0.34 }}>
          <NightEye size={r * 0.68} open={eye} draw={eyeDraw} color={color} hole={hole} />
        </div>
      ) : null}
      {children}
    </div>
  );
};
