import type { ReactNode } from "react";
import type { ThreatBand } from "@/lib/engine/types";

/** Night Shift palette for next/og (Satori cannot read CSS variables). Mirrors src/app/globals.css. */
export const OG = {
  canvas: "#07090D",
  surface: "#0C1017",
  hair: "rgba(255,255,255,0.08)",
  hairStrong: "rgba(255,255,255,0.16)",
  ink: "#F3F6FA",
  ink2: "#9BA7B8",
  ink3: "#5F6B7C",
  phosphor: "#91D982",
  base: "#38BDF8",
  rh: "#C8FF00",
  warn: "#FFB020",
  crit: "#FF4D4F",
} as const;

export const OG_SIZE = { width: 1200, height: 630 } as const;

export const BAND_COLOR: Record<ThreatBand, string> = { NOMINAL: OG.phosphor, ELEVATED: OG.warn, CRITICAL: OG.crit };

export const chainColor = (chainId: number) => (chainId === 4663 ? OG.rh : OG.base);

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Race a promise against a timeout; resolves null on timeout or rejection (never fabricates a value). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

// ---------------------------------------------------------------------------
// Fonts: fetched from Google Fonts at runtime (TTF), cached per process. On any failure the
// image renders with next/og's bundled default font instead.
// ---------------------------------------------------------------------------

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };

async function googleFont(family: string, weight: 400 | 700): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}`, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.text() : ""));
    const url = css.match(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/)?.[1];
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

let fontsP: Promise<OgFont[]> | null = null;

export function loadOgFonts(): Promise<OgFont[]> {
  fontsP ??= Promise.all([
    googleFont("JetBrains Mono", 400).then((d) => (d ? ({ name: "Mono", data: d, weight: 400, style: "normal" } as OgFont) : null)),
    googleFont("JetBrains Mono", 700).then((d) => (d ? ({ name: "Mono", data: d, weight: 700, style: "normal" } as OgFont) : null)),
    googleFont("Instrument Serif", 400).then((d) => (d ? ({ name: "Serif", data: d, weight: 400, style: "normal" } as OgFont) : null)),
  ]).then((fs) => {
    const ok = fs.filter((f): f is OgFont => f !== null);
    if (ok.length < fs.length) fontsP = null; // retry the missing ones on the next render
    return ok;
  });
  return fontsP;
}

/** ImageResponse `fonts` option: undefined (=> bundled default) when nothing loaded. */
export async function ogFontOption(): Promise<OgFont[] | undefined> {
  const f = await loadOgFonts();
  return f.length ? f : undefined;
}

// ---------------------------------------------------------------------------
// Shared marks
// ---------------------------------------------------------------------------

/** Night Eye mark: a crescent moon wrapped around an open raptor eye. Same geometry as components/logo-mark.tsx. */
export function PromptMark({ size, color = OG.phosphor, bg = OG.canvas }: { size: number; color?: string; bg?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <path d="M40 6 A27 27 0 1 0 58 40 A22 22 0 0 1 40 6 Z" fill={color} />
      <circle cx={29} cy={35} r={10.5} fill={bg} />
      <circle cx={29} cy={35} r={7.5} fill="none" stroke={color} strokeWidth={2.4} />
      <circle cx={29} cy={35} r={3.2} fill={color} />
    </svg>
  );
}

export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.4 }}>
      <PromptMark size={size * 1.3} />
      <span style={{ fontFamily: "Mono", fontWeight: 700, fontSize: size, letterSpacing: size * 0.18, color: OG.ink }}>KESTREL</span>
    </div>
  );
}

export function Dot({ color, size = 12 }: { color: string; size?: number }) {
  return <div style={{ display: "flex", width: size, height: size, borderRadius: size, background: color }} />;
}

export function ChainPill({ chainId, size = 18 }: { chainId: number; size?: number }) {
  const c = chainColor(chainId);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${c}55`, borderRadius: 2, padding: "6px 12px", color: c, fontFamily: "Mono", fontSize: size, letterSpacing: 2 }}>
      <Dot color={c} size={size * 0.5} />
      {chainId === 4663 ? "ROBINHOOD · 4663" : "BASE · 8453"}
    </div>
  );
}

/** Full-bleed obsidian frame with the 48px architectural hairline grid. */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: OG.canvas,
        backgroundImage: "linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
        color: OG.ink,
        fontFamily: "Mono",
        padding: "48px 56px",
      }}
    >
      {children}
    </div>
  );
}
