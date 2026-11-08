import React from "react";
import { AbsoluteFill, Freeze, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import footage from "../footage.json";
import { C, mono, sans } from "../theme";
import { clamp, soft } from "./motion";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Clip { file: string; width: number; height: number; durationFrames: number; marks?: Record<string, number>; rects?: Record<string, Rect | null> }
const LIB = footage as unknown as Record<string, Clip>;
export const clip = (name: string): Clip | undefined => LIB[name];
export const markOf = (name: string, m: string) => clip(name)?.marks?.[m] ?? 0;
/** startFrom so that clip mark `m` lands on local frame `at` of the parent sequence. */
export const syncTo = (name: string, m: string, at: number) => Math.max(0, markOf(name, m) - at);
export const rectOf = (name: string, r: string): Rect | undefined => clip(name)?.rects?.[r] ?? undefined;

/** The page the footage was recorded at, in CSS pixels. */
export const PAGE = { w: 1600, h: 900 };

/** A camera keyframe: at local frame `f`, centre on `rect` (page CSS px) at `z` times the fit. */
export interface Cam { f: number; rect?: Rect | string; z?: number; dx?: number; dy?: number }

function camAt(f: number, cams: Cam[], name: string) {
  const pts = cams.map((c) => {
    const r = typeof c.rect === "string" ? rectOf(name, c.rect) : c.rect;
    return { f: c.f, z: c.z ?? (r ? 1.5 : 1), cx: (r ? r.x + r.w / 2 : PAGE.w / 2) + (c.dx ?? 0), cy: (r ? r.y + r.h / 2 : PAGE.h / 2) + (c.dy ?? 0) };
  });
  if (!pts.length) return { z: 1, cx: PAGE.w / 2, cy: PAGE.h / 2 };
  if (f <= pts[0].f) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i].f) {
      const a = pts[i - 1], b = pts[i];
      const t = interpolate(f, [a.f, b.f], [0, 1], { ...clamp, easing: soft });
      return { z: a.z + (b.z - a.z) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
    }
  }
  return pts[pts.length - 1];
}

/**
 * A browser window playing a recorded clip of the live app, with a camera that eases between
 * keyframes. The clip holds its last frame if the scene outlasts it.
 */
export const Browser: React.FC<{
  name: string; url: string; width: number; left: number; top: number;
  startFrom?: number; cams?: Cam[]; enter?: number; exit?: number; tilt?: number; style?: React.CSSProperties; hold?: number; light?: boolean;
  /** Clip frame to freeze on. */ stopAt?: number;
}> = ({ name, url, width, left, top, startFrom = 0, cams = [], enter = 0, exit, tilt = 0, style, hold = 0, light, stopAt }) => {
  const f = useCurrentFrame();
  const c = clip(name);
  const bar = 42;
  const PH = c ? Math.round((PAGE.w * c.height) / c.width) : PAGE.h;
  const vh = (width * PH) / PAGE.w;
  const k = width / PAGE.w;
  const cam = camAt(f, cams, name);
  const s = cam.z;
  const tx = Math.min(0, Math.max(width - PAGE.w * k * s, width / 2 - cam.cx * k * s));
  const ty = Math.min(0, Math.max(vh - PH * k * s, vh / 2 - cam.cy * k * s));
  const inP = interpolate(f, [enter, enter + 20], [0, 1], { ...clamp, easing: soft });
  const outP = exit != null ? interpolate(f, [exit, exit + 14], [0, 1], { ...clamp, easing: soft }) : 0;
  const last = Math.min(c ? c.durationFrames - 2 : 0, stopAt ?? Infinity);
  const pos = Math.max(0, f - hold) + startFrom;
  const video = c ? <OffthreadVideo src={staticFile(c.file)} startFrom={startFrom} muted style={{ width: PAGE.w, height: PH }} /> : null;
  const player = f < hold ? <Freeze frame={0}>{video}</Freeze> : pos >= last ? <Freeze frame={last - startFrom}>{video}</Freeze> : <Sequence from={hold} layout="none">{video}</Sequence>;
  return (
    <div style={{
      position: "absolute", left, top, width, height: vh + bar, borderRadius: 18, overflow: "hidden", background: C.bg,
      boxShadow: light ? "0 0 0 1px rgba(13,12,17,0.14), 0 50px 110px rgba(7,9,13,0.28)" : "0 0 0 1px rgba(255,255,255,0.12), 0 50px 110px rgba(0,0,0,0.6), 0 0 80px rgba(145,217,130,0.08)",
      opacity: inP * (1 - outP), transform: `translateY(${(1 - inP) * 50 - outP * 30}px) scale(${0.97 + 0.03 * inP}) perspective(2400px) rotateX(${tilt * (1 - inP)}deg)`, ...style,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 9, padding: "0 18px", background: "#0E121A", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: "rgba(255,255,255,0.16)" }} />)}
        <div style={{ marginLeft: 16, flex: 1, height: 26, borderRadius: 8, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: mono, fontSize: 14, color: "rgba(255,255,255,0.6)", letterSpacing: "0.02em" }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: C.phos, marginRight: 10, boxShadow: `0 0 8px ${C.phos}` }} />{url}
        </div>
      </div>
      <div style={{ position: "relative", width, height: vh, overflow: "hidden", background: C.bg }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: PAGE.w, height: PH, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k * s})` }}>
          {c ? player : (
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: sans, color: C.ink3, fontSize: 28 }}>footage “{name}” pending</AbsoluteFill>
          )}
        </div>
      </div>
    </div>
  );
};

/** A still capture (the owner's own screenshots) in the same browser frame, with a camera in image pixels. */
export interface ImgCam { f: number; rect?: Rect; z?: number }
export const Shot: React.FC<{
  src: string; iw: number; ih: number; url: string; width: number; height: number; left: number; top: number;
  cams?: ImgCam[]; enter?: number; exit?: number; style?: React.CSSProperties; tag?: string;
}> = ({ src, iw, ih, url, width, height, left, top, cams = [], enter = 0, exit, style, tag }) => {
  const f = useCurrentFrame();
  const bar = 42;
  const fit = width / iw; // fit image width to the window
  const pts = cams.map((c) => ({ f: c.f, z: c.z ?? (c.rect ? Math.min(width / c.rect.w, height / c.rect.h) / fit : 1), cx: c.rect ? c.rect.x + c.rect.w / 2 : iw / 2, cy: c.rect ? c.rect.y + c.rect.h / 2 : (height / fit) / 2 }));
  let cam = pts[0] ?? { z: 1, cx: iw / 2, cy: height / fit / 2 };
  for (let i = 1; i < pts.length; i++) {
    if (f >= pts[i - 1].f) {
      const t = interpolate(f, [pts[i - 1].f, pts[i].f], [0, 1], { ...clamp, easing: soft });
      const a = pts[i - 1], b = pts[i];
      cam = { f: 0, z: a.z + (b.z - a.z) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
    }
  }
  const k = fit * cam.z;
  const tx = Math.min(0, Math.max(width - iw * k, width / 2 - cam.cx * k));
  const ty = Math.min(0, Math.max(height - ih * k, height / 2 - cam.cy * k));
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  const outP = exit != null ? interpolate(f, [exit, exit + 12], [0, 1], { ...clamp, easing: soft }) : 0;
  return (
    <div style={{
      position: "absolute", left, top, width, height: height + bar, borderRadius: 18, overflow: "hidden", background: C.bg,
      boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 50px 110px rgba(0,0,0,0.6)",
      opacity: inP * (1 - outP), transform: `translateY(${(1 - inP) * 40 - outP * 24}px) scale(${0.97 + 0.03 * inP})`, ...style,
    }}>
      <div style={{ height: bar, display: "flex", alignItems: "center", gap: 9, padding: "0 18px", background: "#0E121A", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: "rgba(255,255,255,0.16)" }} />)}
        <div style={{ marginLeft: 16, flex: 1, height: 26, borderRadius: 8, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: mono, fontSize: 14, color: "rgba(255,255,255,0.6)" }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: C.phos, marginRight: 10, boxShadow: `0 0 8px ${C.phos}` }} />{url}
        </div>
        {tag ? <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: "0.12em", color: C.warn, border: `1px solid ${C.warn}66`, padding: "4px 10px", borderRadius: 6, textTransform: "uppercase" }}>{tag}</div> : null}
      </div>
      <div style={{ position: "relative", width, height, overflow: "hidden" }}>
        <Img src={staticFile(src)} style={{ position: "absolute", left: 0, top: 0, width: iw, height: ih, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${k})` }} />
      </div>
    </div>
  );
};

/**
 * A phone frame showing either a recorded clip (video, from footage.json) or a screenshot, scrolled by `scroll`
 * (keyframes in source pixels from the top) for images.
 */
export const Phone: React.FC<{
  left: number; top: number; width: number; video?: string; startFrom?: number; img?: { src: string; w: number; h: number }; scrollY?: number;
  enter?: number; exit?: number; style?: React.CSSProperties; stopAt?: number; hold?: number; label?: string; aspect?: number;
}> = ({ left, top, width, video, startFrom = 0, img, scrollY = 0, enter = 0, exit, style, stopAt, hold = 0, label, aspect = 2.05 }) => {
  const f = useCurrentFrame();
  const h = width * aspect;
  const inP = interpolate(f, [enter, enter + 18], [0, 1], { ...clamp, easing: soft });
  const outP = exit != null ? interpolate(f, [exit, exit + 12], [0, 1], { ...clamp, easing: soft }) : 0;
  const pad = width * 0.035;
  const sw = width - pad * 2, sh = h - pad * 2;
  let content: React.ReactNode = null;
  if (video) {
    const c = clip(video);
    if (c) {
      const vh = (sw * c.height) / c.width;
      const last = Math.min(c.durationFrames - 2, stopAt ?? Infinity);
      const v = <OffthreadVideo src={staticFile(c.file)} startFrom={startFrom} muted style={{ width: sw, height: vh }} />;
      const pos = Math.max(0, f - hold) + startFrom;
      content = f < hold ? <Freeze frame={0}>{v}</Freeze> : pos >= last ? <Freeze frame={last - startFrom}>{v}</Freeze> : <Sequence from={hold} layout="none">{v}</Sequence>;
    }
  } else if (img) {
    const k = sw / img.w;
    content = <Img src={staticFile(img.src)} style={{ position: "absolute", left: 0, top: -scrollY * k, width: sw, height: img.h * k }} />;
  }
  return (
    <div style={{ position: "absolute", left, top, width, height: h, opacity: inP * (1 - outP), transform: `translateY(${(1 - inP) * 60 - outP * 30}px) rotate(${(1 - inP) * 3}deg)`, ...style }}>
      <div style={{ position: "absolute", inset: 0, borderRadius: width * 0.14, background: "#0b0d12", boxShadow: "0 0 0 2px rgba(255,255,255,0.14), 0 60px 120px rgba(0,0,0,0.65)" }} />
      <div style={{ position: "absolute", left: pad, top: pad, width: sw, height: sh, borderRadius: width * 0.11, overflow: "hidden", background: "#000" }}>{content}</div>
      {label ? <div style={{ position: "absolute", left: 0, right: 0, top: h + 18, textAlign: "center", fontFamily: mono, fontSize: 14, letterSpacing: "0.12em", color: "rgba(243,246,250,0.55)", textTransform: "uppercase" }}>{label}</div> : null}
    </div>
  );
};
