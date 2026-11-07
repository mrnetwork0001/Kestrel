import {
  ALPHA_BUCKETS,
  BAND_COLOR,
  barBucket,
  barBucketAlpha,
  barLen,
  bearing,
  type ChainKey,
  COLOR,
  CONTACT_MS,
  gridRadii,
  LANE_NEW_MS,
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
  WRITE_HEAD_MS,
} from "./geometry";

/**
 * Canvas painter for the live Sentinel Watch. Imports only geometry. One static layer (prerendered on resize),
 * then per frame: 12 alpha-bucket strokes + write head per chain, lane marks grouped by style × 4 alpha buckets,
 * contacts, lost-chain hatch, the sweep wedge and the arm. No shadows, no glow, no per-frame allocations beyond
 * what the canvas API itself does.
 */

export interface PaintSeries {
  t: readonly number[];
  /** null = gas unknown for that block: drawn as a minimum-length ink-3 stub. */
  gas: readonly (number | null)[];
}
export interface PaintEvent {
  t: number;
  kind: string;
  contact: boolean;
  chain: ChainKey;
}
export interface PaintInput {
  chains: Record<ChainKey, PaintSeries>;
  events: readonly PaintEvent[];
}
export interface PaintOpts {
  lost: Record<ChainKey, boolean>;
  /** Offline: marks at 40 %. */
  dim: boolean;
  /** Buffering: marks frozen at this replay time while the arm keeps turning. */
  marksAt: number | null;
}

function lastLE(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const STYLES: readonly LaneStyle[] = ["GRANT", "MAX", "REVOKE"];
const CHAINS: readonly ChainKey[] = ["base", "rh"];

export class Painter {
  private ctx: CanvasRenderingContext2D;
  private size = 0;
  private dpr = 1;
  private staticLayer: HTMLCanvasElement | null = null;
  private hatch: Record<ChainKey, HTMLCanvasElement | null> = { base: null, rh: null };
  private wedgeFill: CanvasGradient | null = null;
  private wedgePath: Path2D | null = null;
  strokes = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private font: string
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    this.ctx = ctx;
  }

  get cssSize(): number {
    return this.size;
  }

  /** (Re)build the static layer. Call on resize or when the score changes. */
  resize(cssSize: number, devicePixelRatio: number, score: number | null, band: string | null): void {
    const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
    this.size = cssSize;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.staticLayer = this.buildStatic(score, band);
    this.hatch = { base: this.buildHatch("base"), rh: this.buildHatch("rh") };
    const R = cssSize / 2;
    const ctx = this.ctx;
    if (typeof ctx.createConicGradient === "function") {
      const g = ctx.createConicGradient(-Math.PI / 2 - WEDGE_RAD, 0, 0);
      const w = WEDGE_RAD / TAU;
      g.addColorStop(0, "rgba(145,217,130,0)");
      g.addColorStop(w, "rgba(145,217,130,0.085)");
      g.addColorStop(Math.min(1, w + 0.0005), "rgba(145,217,130,0)");
      g.addColorStop(1, "rgba(145,217,130,0)");
      this.wedgeFill = g;
      const p = new Path2D();
      p.arc(0, 0, RAD.wedgeOut * R, -Math.PI / 2 - WEDGE_RAD, -Math.PI / 2);
      p.arc(0, 0, RAD.wedgeIn * R, -Math.PI / 2, -Math.PI / 2 - WEDGE_RAD, true);
      p.closePath();
      this.wedgePath = p;
    } else {
      this.wedgeFill = null;
      this.wedgePath = null;
    }
  }

  private layer(): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
    const c = document.createElement("canvas");
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const x = c.getContext("2d");
    if (!x) return null;
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return [c, x];
  }

  private buildStatic(score: number | null, band: string | null): HTMLCanvasElement | null {
    const l = this.layer();
    if (!l) return null;
    const [c, x] = l;
    const R = this.size / 2;
    const cx = R;
    const cy = R;
    const circle = (r: number, stroke: string, width = 1, dash: number[] | null = null) => {
      x.beginPath();
      x.arc(cx, cy, r * R, 0, TAU);
      x.setLineDash(dash ?? []);
      x.strokeStyle = stroke;
      x.lineWidth = width;
      x.stroke();
    };
    circle(RAD.rim, COLOR.hairStrong);
    circle(RAD.bezel, COLOR.hair);
    // ticks
    x.setLineDash([]);
    x.lineWidth = 1;
    x.beginPath();
    for (let i = 0; i < 60; i++) {
      if (i % 5 === 0) continue;
      const a = (i / 60) * TAU;
      x.moveTo(cx + RAD.minorIn * R * Math.sin(a), cy - RAD.minorIn * R * Math.cos(a));
      x.lineTo(cx + RAD.tickOut * R * Math.sin(a), cy - RAD.tickOut * R * Math.cos(a));
    }
    x.strokeStyle = COLOR.minorTick;
    x.stroke();
    x.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      x.moveTo(cx + RAD.majorIn * R * Math.sin(a), cy - RAD.majorIn * R * Math.cos(a));
      x.lineTo(cx + RAD.tickOut * R * Math.sin(a), cy - RAD.tickOut * R * Math.cos(a));
    }
    x.strokeStyle = COLOR.ink3;
    x.stroke();
    // labels on a knockout
    x.font = `8px ${this.font}`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    for (const [s, a] of [
      ["00", 0],
      ["15", Math.PI / 2],
      ["30", Math.PI],
      ["45", (3 * Math.PI) / 2],
    ] as const) {
      const lx = cx + RAD.label * R * Math.sin(a);
      const ly = cy - RAD.label * R * Math.cos(a);
      x.fillStyle = COLOR.surface;
      x.fillRect(lx - 7, ly - 5, 14, 10);
      x.fillStyle = COLOR.ink3;
      x.fillText(s, lx, ly + 0.5);
    }
    for (const ch of CHAINS) {
      circle(RING[ch].r0, RING[ch].baseline);
      for (const r of gridRadii(ch)) circle(r, COLOR.track, 1, [1, 3]);
    }
    x.setLineDash([]);
    // centre disc + dial
    x.beginPath();
    x.arc(cx, cy, RAD.disc * R, 0, TAU);
    x.fillStyle = COLOR.surface;
    x.fill();
    x.strokeStyle = COLOR.hair;
    x.lineWidth = 1;
    x.stroke();
    circle(RAD.dial, COLOR.track);
    if (score !== null && score > 0) {
      x.beginPath();
      x.arc(cx, cy, RAD.dial * R, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, score) / 100) * TAU);
      x.strokeStyle = band ? (BAND_COLOR[band] ?? COLOR.ink3) : COLOR.ink3;
      x.lineWidth = 1.5;
      x.stroke();
    }
    return c;
  }

  private buildHatch(ch: ChainKey): HTMLCanvasElement | null {
    const l = this.layer();
    if (!l) return null;
    const [c, x] = l;
    const R = this.size / 2;
    x.beginPath();
    x.arc(R, R, RING[ch].lane1 * R, 0, TAU);
    x.arc(R, R, RING[ch].r0 * R, 0, TAU, true);
    x.clip();
    x.beginPath();
    for (let k = -this.size; k < this.size * 2; k += 6) {
      x.moveTo(k, 0);
      x.lineTo(k + this.size, this.size);
    }
    x.strokeStyle = COLOR.hatch;
    x.lineWidth = 1;
    x.stroke();
    return c;
  }

  /** Paint one frame; returns the number of block bars drawn. */
  frame(input: PaintInput, replayNow: number, opts: PaintOpts): number {
    const ctx = this.ctx;
    const size = this.size;
    if (!size) return 0;
    const R = size / 2;
    const cx = R;
    const cy = R;
    this.strokes = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = "butt";
    const now = opts.marksAt ?? replayNow;
    const markAlpha = opts.dim ? 0.4 : 1;
    let bars = 0;

    // ── blocks ──
    ctx.lineWidth = 1;
    for (const ch of CHAINS) {
      const s = input.chains[ch];
      const ring = RING[ch];
      const r0 = ring.r0 * R;
      const band = (ring.r1 - ring.r0) * R;
      const hi = lastLE(s.t, now);
      let i = hi;
      // write head: bars younger than 150 ms, #F3F6FA at .9
      if (i >= 0 && now - s.t[i] < WRITE_HEAD_MS) {
        ctx.beginPath();
        while (i >= 0 && now - s.t[i] < WRITE_HEAD_MS) {
          const a = bearing(s.t[i]);
          const sn = Math.sin(a);
          const cs = Math.cos(a);
          const r1 = r0 + barLen(s.gas[i] ?? 0) * band;
          ctx.moveTo(cx + r0 * sn, cy - r0 * cs);
          ctx.lineTo(cx + r1 * sn, cy - r1 * cs);
          bars++;
          i--;
        }
        ctx.globalAlpha = 0.9 * markAlpha;
        ctx.strokeStyle = COLOR.ink;
        ctx.stroke();
        this.strokes++;
      }
      ctx.strokeStyle = ring.color;
      let bucket = -1;
      let stubs = 0;
      const iTop = i;
      while (i >= 0) {
        const age = now - s.t[i];
        if (age > MINUTE_MS) break;
        const b = barBucket(age);
        if (b !== bucket) {
          if (bucket >= 0) {
            ctx.globalAlpha = barBucketAlpha(ch, bucket) * markAlpha;
            ctx.stroke();
            this.strokes++;
          }
          bucket = b;
          ctx.beginPath();
        }
        const g = s.gas[i];
        bars++;
        if (g === null || g === undefined) {
          stubs++;
          i--;
          continue;
        }
        const a = bearing(s.t[i]);
        const sn = Math.sin(a);
        const cs = Math.cos(a);
        const r1 = r0 + barLen(g) * band;
        ctx.moveTo(cx + r0 * sn, cy - r0 * cs);
        ctx.lineTo(cx + r1 * sn, cy - r1 * cs);
        i--;
      }
      if (bucket >= 0 && bucket < ALPHA_BUCKETS) {
        ctx.globalAlpha = barBucketAlpha(ch, bucket) * markAlpha;
        ctx.stroke();
        this.strokes++;
      }
      // unknown-gas blocks (null): minimum-length neutral stubs, never a guessed length
      if (stubs) {
        ctx.beginPath();
        const rs = r0 + barLen(0) * band;
        for (let k = iTop; k > i; k--) {
          if (s.gas[k] !== null && s.gas[k] !== undefined) continue;
          const a = bearing(s.t[k]);
          ctx.moveTo(cx + r0 * Math.sin(a), cy - r0 * Math.cos(a));
          ctx.lineTo(cx + rs * Math.sin(a), cy - rs * Math.cos(a));
        }
        ctx.globalAlpha = 0.8 * markAlpha;
        ctx.strokeStyle = COLOR.ink3;
        ctx.stroke();
        this.strokes++;
      }
    }

    // ── Permit2 lane marks: style × 4 alpha buckets ──
    const ev = input.events;
    let top = ev.length - 1;
    while (top >= 0 && ev[top].t > now) top--;
    for (const style of STYLES) {
      const st = LANE_STYLE[style];
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      let bucket = -1;
      for (let k = top; k >= 0; k--) {
        const e = ev[k];
        const age = now - e.t;
        if (age > MINUTE_MS) break;
        if (e.contact || laneStyleOf(e.kind) !== style) continue;
        const b = laneBucket(age);
        if (b !== bucket) {
          if (bucket >= 0) {
            ctx.globalAlpha = laneBucketAlpha(bucket) * markAlpha;
            ctx.stroke();
            this.strokes++;
          }
          bucket = b;
          ctx.beginPath();
        }
        const ring = RING[e.chain];
        const a = bearing(e.t);
        const sn = Math.sin(a);
        const cs = Math.cos(a);
        const fresh = age < LANE_NEW_MS ? 4 : 0;
        const l0 = ring.lane0 * R - fresh;
        const l1 = ring.lane1 * R + fresh;
        ctx.moveTo(cx + l0 * sn, cy - l0 * cs);
        ctx.lineTo(cx + l1 * sn, cy - l1 * cs);
      }
      if (bucket >= 0) {
        ctx.globalAlpha = (bucket === 0 && top >= 0 && now - ev[top].t < LANE_NEW_MS ? 1 : laneBucketAlpha(bucket)) * markAlpha;
        ctx.stroke();
        this.strokes++;
      }
    }

    // ── $VIBES contacts (≤ 180 s) ──
    for (let k = top; k >= 0; k--) {
      const e = ev[k];
      const age = now - e.t;
      if (age > CONTACT_MS) break;
      if (!e.contact) continue;
      const a = bearing(e.t);
      const sn = Math.sin(a);
      const cs = Math.cos(a);
      ctx.globalAlpha = (1 - 0.5 * (age / CONTACT_MS)) * markAlpha;
      ctx.strokeStyle = RING[e.chain].color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + RAD.contactIn * R * sn, cy - RAD.contactIn * R * cs);
      ctx.lineTo(cx + RAD.contactOut * R * sn, cy - RAD.contactOut * R * cs);
      const bx = cx + RAD.bracket * R * sn;
      const by = cy - RAD.bracket * R * cs;
      for (let q = 0; q < 4; q++) {
        const sx = q === 0 || q === 3 ? -1 : 1;
        const sy = q < 2 ? -1 : 1;
        const x = bx + sx * 8;
        const y = by + sy * 8;
        ctx.moveTo(x, y - sy * 8);
        ctx.lineTo(x, y);
        ctx.lineTo(x - sx * 8, y);
      }
      ctx.stroke();
      this.strokes++;
    }

    // ── lost-chain hatch ──
    ctx.globalAlpha = 1;
    for (const ch of CHAINS) {
      const h = this.hatch[ch];
      if (opts.lost[ch] && h) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(h, 0, 0);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      }
    }

    // ── wedge + arm (the arm always turns: it is the clock) ──
    const arm = bearing(replayNow);
    if (this.wedgeFill && this.wedgePath) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(arm);
      ctx.fillStyle = this.wedgeFill;
      ctx.fill(this.wedgePath);
      ctx.restore();
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLOR.phosphor;
      for (let q = 0; q < 14; q++) {
        const a = arm - WEDGE_RAD * (1 - q / 14);
        ctx.globalAlpha = 0.02 + (0.16 * q) / 13;
        ctx.beginPath();
        ctx.moveTo(cx + RAD.wedgeIn * R * Math.sin(a), cy - RAD.wedgeIn * R * Math.cos(a));
        ctx.lineTo(cx + RAD.wedgeOut * R * Math.sin(a), cy - RAD.wedgeOut * R * Math.cos(a));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR.phosphor;
    ctx.beginPath();
    ctx.moveTo(cx + RAD.armIn * R * Math.sin(arm), cy - RAD.armIn * R * Math.cos(arm));
    ctx.lineTo(cx + RAD.armOut * R * Math.sin(arm), cy - RAD.armOut * R * Math.cos(arm));
    ctx.stroke();
    this.strokes++;
    return bars;
  }
}
