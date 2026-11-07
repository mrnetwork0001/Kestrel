import {
  barBucket,
  barBucketAlpha,
  barLen,
  bearing,
  BAND_COLOR,
  type ChainKey,
  COLOR,
  CONTACT_MS,
  gridRadii,
  LANE_STYLE,
  laneBucket,
  laneBucketAlpha,
  type LaneStyle,
  laneStyleOf,
  MINUTE_MS,
  RAD,
  RING,
  TAU,
  WEDGE_RAD,
} from "./geometry";

/**
 * Static Sentinel Watch face (SVG, viewBox 1000×1000). No "use client", no server imports: it renders the SSR
 * snapshot, the hydration frame, the reduced-motion face (re-rendered every 10 s) and the offline fallback.
 * Every bar is one real block (√gasUsedRatio); every lane mark one real Permit2 log.
 */

export interface BlockSeries {
  n: readonly number[];
  t: readonly number[];
  /** Per-block gas fraction; null = unknown (drawn as a neutral ink-3 stub, never guessed). */
  gas: readonly (number | null)[];
}

export interface FaceEvent {
  t: number;
  kind: string;
  contact: boolean;
  chain: ChainKey;
}

export interface FaceInput {
  chains: Record<ChainKey, BlockSeries>;
  events: readonly FaceEvent[];
  nowT: number;
  lost: Record<ChainKey, boolean>;
  score: number | null;
  band: string | null;
}

export interface FaceData {
  arm: number;
  bars: { chain: ChainKey; alpha: number; d: string }[];
  /** Blocks whose gas is unknown: minimum-length stubs in ink-3. */
  stubs: string;
  lanes: { style: LaneStyle; alpha: number; d: string }[];
  contacts: { chain: ChainKey; alpha: number; d: string; brackets: string }[];
  lost: Record<ChainKey, boolean>;
  score: number | null;
  band: string | null;
}

const C = 500;
const S = 500; // R in viewBox units
const f1 = (x: number) => (Math.round(x * 10) / 10).toString();

function radial(a: number, r0: number, r1: number): string {
  const s = Math.sin(a);
  const c = Math.cos(a);
  return `M${f1(C + r0 * S * s)} ${f1(C - r0 * S * c)}L${f1(C + r1 * S * s)} ${f1(C - r1 * S * c)}`;
}

function arcPath(r: number, a0: number, a1: number): string {
  const x0 = C + r * S * Math.sin(a0);
  const y0 = C - r * S * Math.cos(a0);
  const x1 = C + r * S * Math.sin(a1);
  const y1 = C - r * S * Math.cos(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${f1(x0)} ${f1(y0)}A${f1(r * S)} ${f1(r * S)} 0 ${large} 1 ${f1(x1)} ${f1(y1)}`;
}

function bracketsAt(a: number): string {
  const cx = C + RAD.bracket * S * Math.sin(a);
  const cy = C - RAD.bracket * S * Math.cos(a);
  const h = 22;
  const arm = 12;
  const out: string[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const x = cx + sx * h;
    const y = cy + sy * h;
    out.push(`M${f1(x)} ${f1(y - sy * arm)}L${f1(x)} ${f1(y)}L${f1(x - sx * arm)} ${f1(y)}`);
  }
  return out.join("");
}

/** Shared by SSR (from a pulse) and the reduced-motion client (from the replay buffer). */
export function buildFace(input: FaceInput): FaceData {
  const { nowT } = input;
  const lo = nowT - MINUTE_MS;
  const bars: FaceData["bars"] = [];
  const stubs: string[] = [];
  for (const chain of ["base", "rh"] as const) {
    const s = input.chains[chain];
    const ring = RING[chain];
    const band = ring.r1 - ring.r0;
    const buckets: string[][] = Array.from({ length: 12 }, () => []);
    for (let i = 0; i < s.t.length; i++) {
      const t = s.t[i];
      if (t < lo || t > nowT) continue;
      const g = s.gas[i];
      if (g === null || g === undefined) stubs.push(radial(bearing(t), ring.r0, ring.r0 + barLen(0) * band));
      else buckets[barBucket(nowT - t)].push(radial(bearing(t), ring.r0, ring.r0 + barLen(g) * band));
    }
    buckets.forEach((segs, b) => {
      if (segs.length) bars.push({ chain, alpha: Math.round(barBucketAlpha(chain, b) * 1000) / 1000, d: segs.join("") });
    });
  }

  const lanes: FaceData["lanes"] = [];
  const laneSegs: Record<LaneStyle, string[][]> = { GRANT: [[], [], [], []], MAX: [[], [], [], []], REVOKE: [[], [], [], []] };
  const contacts: FaceData["contacts"] = [];
  for (const e of input.events) {
    if (e.t > nowT) continue;
    const age = nowT - e.t;
    const a = bearing(e.t);
    if (e.contact) {
      if (age <= CONTACT_MS) contacts.push({ chain: e.chain, alpha: Math.round((1 - 0.5 * (age / CONTACT_MS)) * 1000) / 1000, d: radial(a, RAD.contactIn, RAD.contactOut), brackets: bracketsAt(a) });
      continue;
    }
    if (age > MINUTE_MS) continue;
    const style = laneStyleOf(e.kind);
    if (!style) continue;
    const ring = RING[e.chain];
    laneSegs[style][laneBucket(age)].push(radial(a, ring.lane0, ring.lane1));
  }
  for (const style of ["GRANT", "MAX", "REVOKE"] as const) {
    laneSegs[style].forEach((segs, b) => {
      if (segs.length) lanes.push({ style, alpha: Math.round(laneBucketAlpha(b) * 1000) / 1000, d: segs.join("") });
    });
  }
  return { arm: bearing(nowT), bars, stubs: stubs.join(""), lanes, contacts, lost: input.lost, score: input.score, band: input.band };
}

/** Minimal structural pulse (avoids importing server modules). */
export interface PulseLike {
  chains: Record<
    ChainKey,
    { ok: boolean; from: string | null; to: string | null; gas: (number | null)[]; anchor: { block: string; timeMs: number; exact: boolean } | null; cadenceMs: number }
  >;
  events: { chainId: number; block: string; kind: string; contact: boolean }[];
}

/** Block series with formula times t(n) = anchor.timeMs + (n − anchor.block)·cadence (same formula as the client). */
export function seriesFromPulse(p: PulseLike): { chains: Record<ChainKey, BlockSeries>; nowT: number | null; timeOf: (chain: ChainKey, n: number) => number | null } {
  const chains = { base: { n: [] as number[], t: [] as number[], gas: [] as (number | null)[] }, rh: { n: [] as number[], t: [] as number[], gas: [] as (number | null)[] } };
  const timeOf = (chain: ChainKey, n: number) => {
    const c = p.chains[chain];
    if (!c.ok || !c.anchor) return null;
    return c.anchor.timeMs + (n - Number(c.anchor.block)) * c.cadenceMs;
  };
  for (const chain of ["base", "rh"] as const) {
    const c = p.chains[chain];
    if (!c.ok || c.from === null || c.to === null) continue;
    const from = Number(c.from);
    for (let i = 0; i < c.gas.length; i++) {
      chains[chain].n.push(from + i);
      chains[chain].t.push(timeOf(chain, from + i) as number);
      chains[chain].gas.push(c.gas[i]);
    }
  }
  const bt = chains.base.t;
  const rt = chains.rh.t;
  // Snapshot second = newest Base block time (exact timestampMs), else the newest Robinhood block.
  const nowT = bt.length ? bt[bt.length - 1] : rt.length ? rt[rt.length - 1] : null;
  return { chains, nowT, timeOf };
}

export function faceDataFromPulse(p: PulseLike | null, scan: { score: number; band: string } | null): FaceData | null {
  if (!p) return null;
  const { chains, nowT, timeOf } = seriesFromPulse(p);
  if (nowT === null) return null;
  const events: FaceEvent[] = [];
  for (const e of p.events) {
    const chain: ChainKey = e.chainId === 4663 ? "rh" : "base";
    const t = timeOf(chain, Number(e.block));
    if (t !== null) events.push({ t, kind: e.kind, contact: e.contact, chain });
  }
  return buildFace({ chains, events, nowT, lost: { base: !p.chains.base.ok, rh: !p.chains.rh.ok }, score: scan?.score ?? null, band: scan?.band ?? null });
}

// ── static decoration (deterministic, computed once at module load) ────────────────────────────────────────
const MINOR = Array.from({ length: 60 }, (_, i) => i)
  .filter((i) => i % 5 !== 0)
  .map((i) => radial((i / 60) * TAU, RAD.minorIn, RAD.tickOut))
  .join("");
const MAJOR = Array.from({ length: 12 }, (_, i) => radial((i / 12) * TAU, RAD.majorIn, RAD.tickOut)).join("");
const LABELS = [
  { s: "00", a: 0 },
  { s: "15", a: Math.PI / 2 },
  { s: "30", a: Math.PI },
  { s: "45", a: (3 * Math.PI) / 2 },
].map((l) => ({ ...l, x: f1(C + RAD.label * S * Math.sin(l.a)), y: f1(C - RAD.label * S * Math.cos(l.a)) }));

function annulus(r0: number, r1: number): string {
  const a = r0 * S;
  const b = r1 * S;
  return `M${C - b} ${C}a${b} ${b} 0 1 0 ${2 * b} 0a${b} ${b} 0 1 0 ${-2 * b} 0ZM${C - a} ${C}a${a} ${a} 0 1 1 ${2 * a} 0a${a} ${a} 0 1 1 ${-2 * a} 0Z`;
}

const NS = { vectorEffect: "non-scaling-stroke" as const };

export function FaceSvg({ data, className }: { data: FaceData | null; className?: string }) {
  const armA = data?.arm ?? 0;
  const wedge = Array.from({ length: 14 }, (_, i) => {
    const a = armA - WEDGE_RAD * (1 - i / 14);
    return { d: radial(a, RAD.wedgeIn, RAD.wedgeOut), o: Math.round((0.02 + (0.16 * i) / 13) * 1000) / 1000 };
  });
  const score = data?.score ?? null;
  const bandColor = data?.band ? (BAND_COLOR[data.band] ?? COLOR.ink3) : COLOR.ink3;
  return (
    <svg viewBox="0 0 1000 1000" className={className} aria-hidden="true" focusable="false" data-sentinel-svg="">
      <defs>
        <pattern id="sw-hatch" width="17" height="17" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0L0 17" stroke={COLOR.hatch} strokeWidth="1" style={NS} />
        </pattern>
      </defs>
      {/* rim, bezel, ticks, labels */}
      <circle cx={C} cy={C} r={RAD.rim * S} fill="none" stroke={COLOR.hairStrong} strokeWidth="1" style={NS} />
      <circle cx={C} cy={C} r={RAD.bezel * S} fill="none" stroke={COLOR.hair} strokeWidth="1" style={NS} />
      <path d={MINOR} stroke={COLOR.minorTick} strokeWidth="1" style={NS} />
      <path d={MAJOR} stroke={COLOR.ink3} strokeWidth="1" style={NS} />
      {LABELS.map((l) => (
        <g key={l.s}>
          <rect x={Number(l.x) - 17} y={Number(l.y) - 12} width="34" height="24" fill={COLOR.surface} />
          <text x={l.x} y={l.y} fill={COLOR.ink3} fontSize="22" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-mono), monospace">
            {l.s}
          </text>
        </g>
      ))}
      {/* ring baselines + √-gas gridlines (10%, 50%) */}
      {(["base", "rh"] as const).map((ch) => (
        <g key={ch}>
          <circle cx={C} cy={C} r={RING[ch].r0 * S} fill="none" stroke={RING[ch].baseline} strokeWidth="1" style={NS} />
          {gridRadii(ch).map((r) => (
            <circle key={r} cx={C} cy={C} r={f1(r * S)} fill="none" stroke={COLOR.track} strokeWidth="1" strokeDasharray="1 3" style={NS} />
          ))}
        </g>
      ))}
      {/* lost chain hatch */}
      {data?.lost.base && <path d={annulus(RING.base.r0, RING.base.lane1)} fill="url(#sw-hatch)" fillRule="evenodd" />}
      {data?.lost.rh && <path d={annulus(RING.rh.r0, RING.rh.lane1)} fill="url(#sw-hatch)" fillRule="evenodd" />}
      {/* blocks: 12 alpha buckets × 2 chains */}
      {data?.bars.map((b, i) => <path key={`b${i}`} d={b.d} stroke={RING[b.chain].color} strokeOpacity={b.alpha} strokeWidth="1" style={NS} />)}
      {data?.stubs ? <path d={data.stubs} stroke={COLOR.ink3} strokeOpacity={0.8} strokeWidth="1" style={NS} /> : null}
      {/* Permit2 lanes */}
      {data?.lanes.map((l, i) => <path key={`l${i}`} d={l.d} stroke={LANE_STYLE[l.style].color} strokeOpacity={l.alpha} strokeWidth={LANE_STYLE[l.style].width} style={NS} />)}
      {/* $VIBES contacts */}
      {data?.contacts.map((c, i) => (
        <g key={`c${i}`} stroke={RING[c.chain].color} strokeOpacity={c.alpha} fill="none" style={NS}>
          <path d={c.d} strokeWidth="2" style={NS} />
          <path d={c.brackets} strokeWidth="1" style={NS} />
        </g>
      ))}
      {/* sweep wedge (fallback: 14 radial lines) + arm */}
      {data && wedge.map((w, i) => <path key={`w${i}`} d={w.d} stroke={COLOR.phosphor} strokeOpacity={w.o} strokeWidth="1" style={NS} />)}
      {data && <path d={radial(armA, RAD.armIn, RAD.armOut)} stroke={COLOR.phosphor} strokeWidth="1" style={NS} />}
      {/* centre disc + threat dial */}
      <circle cx={C} cy={C} r={RAD.disc * S} fill={COLOR.surface} stroke={COLOR.hair} strokeWidth="1" style={NS} />
      <circle cx={C} cy={C} r={RAD.dial * S} fill="none" stroke={COLOR.track} strokeWidth="1" style={NS} />
      {score !== null && score >= 100 && <circle cx={C} cy={C} r={RAD.dial * S} fill="none" stroke={bandColor} strokeWidth="1.5" style={NS} />}
      {score !== null && score > 0 && score < 100 && <path d={arcPath(RAD.dial, 0, (score / 100) * TAU)} fill="none" stroke={bandColor} strokeWidth="1.5" style={NS} />}
    </svg>
  );
}

// ── shared formatting + stats (deterministic: no Date.now, en-US grouping, ISO slices) ──────────────────────
export function group(n: number | string): string {
  const s = typeof n === "number" ? Math.trunc(n).toString() : n;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function hms(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}
export function hmsd(ms: number): string {
  return new Date(ms).toISOString().slice(11, 21);
}
/** Robinhood timestamps have 1 s resolution and its bearings are interpolated: "≈HH:MM:SS". */
export function hmsApprox(ms: number): string {
  return `≈${hms(ms)}`;
}
export function hm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

export interface ChainStats {
  head: number | null;
  headT: number | null;
  perSec: number | null;
  /** Mean per-block gas fraction (%) of the newest ≤ 25 blocks with known gas (Base: gasUsed/gasLimit). */
  gasPct: number | null;
  /** Σ per-block gas fraction over the 10 s ending at the head (known blocks only); null = window not covered. */
  gasSum10: number | null;
  /** Blocks on the face (t in [now − 60 s, now]). */
  bars60: number;
}
export interface FaceStats {
  base: ChainStats;
  rh: ChainStats;
  p2: { base: number; baseMax: number; rh: number; rhMax: number; revokes: number; total: number; max: number };
  vibes: number;
  coverageSec: number;
  bars: number;
}

/** Real counters over the last 60 s (rails, strips, captions, aria summary). Same code for SSR and live. */
export function computeStats(chains: Record<ChainKey, BlockSeries>, events: readonly FaceEvent[], nowT: number): FaceStats {
  const cs = (s: BlockSeries): ChainStats => {
    let hi = s.t.length - 1;
    while (hi >= 0 && s.t[hi] > nowT) hi--;
    if (hi < 0) return { head: null, headT: null, perSec: null, gasPct: null, gasSum10: null, bars60: 0 };
    // blk/s over the 10 s ending at this chain's newest replayed block
    const tHead = s.t[hi];
    let k = hi;
    while (k >= 0 && s.t[k] > tHead - 10_000) k--;
    const covered = s.t[0] <= tHead - 10_000;
    let j = hi;
    while (j >= 0 && s.t[j] >= nowT - MINUTE_MS) j--;
    let sum = 0;
    let cnt = 0;
    for (let i = hi; i >= 0 && cnt < 25; i--) {
      const g = s.gas[i];
      if (g === null || g === undefined) continue;
      sum += Math.min(1, g);
      cnt++;
    }
    let sum10 = 0;
    for (let i = hi; i > k; i--) sum10 += s.gas[i] ?? 0;
    return { head: s.n[hi], headT: tHead, perSec: covered ? (hi - k) / 10 : null, gasPct: cnt ? (sum / cnt) * 100 : null, gasSum10: covered ? sum10 : null, bars60: hi - j };
  };
  const p2 = { base: 0, baseMax: 0, rh: 0, rhMax: 0, revokes: 0, total: 0, max: 0 };
  let vibes = 0;
  for (const e of events) {
    if (e.t > nowT || e.t < nowT - MINUTE_MS) continue;
    if (e.contact) {
      vibes++;
      continue;
    }
    const st = laneStyleOf(e.kind);
    if (!st) continue;
    p2.total++;
    if (e.chain === "base") p2.base++;
    else p2.rh++;
    if (st === "MAX") {
      p2.max++;
      if (e.chain === "base") p2.baseMax++;
      else p2.rhMax++;
    }
    if (st === "REVOKE") p2.revokes++;
  }
  let earliest = Infinity;
  let bars = 0;
  for (const ch of ["base", "rh"] as const) {
    const s = chains[ch];
    if (s.t.length) earliest = Math.min(earliest, s.t[0]);
    for (let i = s.t.length - 1; i >= 0; i--) {
      if (s.t[i] > nowT) continue;
      if (s.t[i] < nowT - MINUTE_MS) break;
      bars++;
    }
  }
  const coverageSec = Number.isFinite(earliest) ? Math.max(0, Math.min(60, Math.floor((nowT - earliest) / 1000))) : 0;
  return { base: cs(chains.base), rh: cs(chains.rh), p2, vibes, coverageSec, bars };
}
