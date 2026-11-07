/**
 * Sentinel Watch face geometry: pure constants + math shared by the SSR SVG (face-svg.tsx) and the canvas painter.
 * Zero imports. Radii are fractions of R = face / 2. Angle 0 = 12 o'clock, increasing clockwise.
 */

export const TAU = Math.PI * 2;
export const MINUTE_MS = 60_000;

export const RAD = {
  disc: 0.27,
  dial: 0.29,
  baseIn: 0.31,
  baseOut: 0.55,
  baseLaneIn: 0.565,
  baseLaneOut: 0.6,
  rhIn: 0.63,
  rhOut: 0.86,
  rhLaneIn: 0.875,
  rhLaneOut: 0.91,
  bezel: 0.93,
  minorIn: 0.965,
  majorIn: 0.945,
  tickOut: 0.99,
  label: 0.965,
  rim: 0.997,
  armIn: 0.31,
  armOut: 0.99,
  wedgeIn: 0.31,
  wedgeOut: 0.93,
  contactIn: 0.31,
  contactOut: 0.91,
  bracket: 0.93,
} as const;

export const WEDGE_RAD = (24 * Math.PI) / 180;

export const COLOR = {
  surface: "#0C1017",
  elevated: "#121822",
  ink: "#F3F6FA",
  ink2: "#9BA7B8",
  ink3: "#5F6B7C",
  phosphor: "#91D982",
  base: "#38BDF8",
  rh: "#C8FF00",
  warn: "#FFB020",
  crit: "#FF4D4F",
  hair: "rgba(255,255,255,0.08)",
  hairStrong: "rgba(255,255,255,0.16)",
  track: "rgba(255,255,255,0.06)",
  minorTick: "rgba(255,255,255,0.12)",
  baseBaseline: "rgba(56,189,248,0.30)",
  rhBaseline: "rgba(200,255,0,0.22)",
  hatch: "rgba(255,255,255,0.08)",
} as const;

export const BAND_COLOR: Record<string, string> = { NOMINAL: COLOR.phosphor, ELEVATED: COLOR.warn, CRITICAL: COLOR.crit };

export type ChainKey = "base" | "rh";

/** Ring (bar band) and Permit2 lane radii per chain. */
export const RING: Record<ChainKey, { r0: number; r1: number; lane0: number; lane1: number; color: string; baseline: string; peak: number; floor: number }> = {
  base: { r0: RAD.baseIn, r1: RAD.baseOut, lane0: RAD.baseLaneIn, lane1: RAD.baseLaneOut, color: COLOR.base, baseline: COLOR.baseBaseline, peak: 0.95, floor: 0.12 },
  rh: { r0: RAD.rhIn, r1: RAD.rhOut, lane0: RAD.rhLaneIn, lane1: RAD.rhLaneOut, color: COLOR.rh, baseline: COLOR.rhBaseline, peak: 0.72, floor: 0.1 },
};

/** Bearing of a wall-clock time (ms): the second hand of the real UTC clock. */
export function bearing(t: number): number {
  return (TAU * (((t % MINUTE_MS) + MINUTE_MS) % MINUTE_MS)) / MINUTE_MS;
}

/** Bar length as a fraction of the ring band: √gasUsedRatio, with a stub so empty blocks are never dropped. */
export function barLen(gas: number): number {
  const g = Number.isFinite(gas) ? Math.min(1, Math.max(0, gas)) : 0;
  return Math.max(0.05, Math.sqrt(g));
}

export const ALPHA_BUCKETS = 12;
export const ALPHA_BUCKET_MS = 5_000;
export const LANE_BUCKETS = 4;
export const LANE_BUCKET_MS = 15_000;
export const WRITE_HEAD_MS = 150;
export const LANE_NEW_MS = 400;
export const CONTACT_MS = 180_000;

/** 0..11 — bars are drawn in 12 alpha buckets of 5 s. */
export function barBucket(ageMs: number): number {
  return Math.min(ALPHA_BUCKETS - 1, Math.max(0, Math.floor(ageMs / ALPHA_BUCKET_MS)));
}

/** Alpha of a bar bucket: floor + (peak − floor)·e^(−age/20 s), quantised to the bucket start. */
export function barBucketAlpha(chain: ChainKey, bucket: number): number {
  const { peak, floor } = RING[chain];
  return floor + (peak - floor) * Math.exp(-(bucket * ALPHA_BUCKET_MS) / 20_000);
}

export function laneBucket(ageMs: number): number {
  return Math.min(LANE_BUCKETS - 1, Math.max(0, Math.floor(ageMs / LANE_BUCKET_MS)));
}

/** Lane-mark alpha: .9·max(.3, e^(−age/40 s)), quantised to 4 buckets of 15 s. */
export function laneBucketAlpha(bucket: number): number {
  return 0.9 * Math.max(0.3, Math.exp(-(bucket * LANE_BUCKET_MS) / 40_000));
}

export type LaneStyle = "GRANT" | "MAX" | "REVOKE";
export const LANE_STYLE: Record<LaneStyle, { color: string; width: number }> = {
  GRANT: { color: COLOR.ink, width: 1.25 },
  MAX: { color: COLOR.warn, width: 1.25 },
  REVOKE: { color: COLOR.phosphor, width: 2 },
};

export function laneStyleOf(kind: string): LaneStyle | null {
  if (kind === "P2_GRANT") return "GRANT";
  if (kind === "P2_MAX") return "MAX";
  if (kind === "P2_REVOKE") return "REVOKE";
  return null;
}

/** Dotted gridlines at gas 10% and 50% (√ scale). */
export function gridRadii(chain: ChainKey): [number, number] {
  const { r0, r1 } = RING[chain];
  const band = r1 - r0;
  return [r0 + Math.sqrt(0.1) * band, r0 + Math.sqrt(0.5) * band];
}

/** Point at radius r (any unit) and bearing a around (cx, cy). */
export function px(cx: number, r: number, a: number): number {
  return cx + r * Math.sin(a);
}
export function py(cy: number, r: number, a: number): number {
  return cy - r * Math.cos(a);
}

export type Zone = { chain: ChainKey; lane: boolean } | null;

/** Hit-test zone for a radius fraction (0..1 of R). */
export function zoneAt(rFrac: number): Zone {
  if (rFrac >= RAD.baseIn - 0.01 && rFrac <= RAD.baseOut + 0.005) return { chain: "base", lane: false };
  if (rFrac > RAD.baseOut + 0.005 && rFrac <= RAD.baseLaneOut + 0.012) return { chain: "base", lane: true };
  if (rFrac >= RAD.rhIn - 0.015 && rFrac <= RAD.rhOut + 0.005) return { chain: "rh", lane: false };
  if (rFrac > RAD.rhOut + 0.005 && rFrac <= RAD.rhLaneOut + 0.015) return { chain: "rh", lane: true };
  return null;
}

/** Smallest absolute angular distance between two bearings. */
export function angDist(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
}

/** Bearing of a pointer at (dx, dy) from centre (screen coordinates, y down). */
export function pointerBearing(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy);
  return a < 0 ? a + TAU : a;
}
