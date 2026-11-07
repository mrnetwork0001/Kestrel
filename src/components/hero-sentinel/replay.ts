/**
 * Sentinel Watch replay scheduler. Pure, zero imports (input types are structural), so node:test loads it directly.
 *
 *  - ReplayBuffer merges /api/pulse responses into per-chain block arrays (n, t, gas) and a deduped event list.
 *    Block times: t(n) = anchor.timeMs + (n − anchor.block)·cadence, then spacing-clamped to [0.5c, 1.5c] so bars
 *    never bunch or jump. Gaps are recorded and NEVER filled. Nothing is extrapolated past the newest real block.
 *  - ReplayClock turns wall-clock time into a skew-free replay time a few seconds behind the newest received block.
 *  - minuteSweep summarises a UTC minute from the buffer for the tape.
 *
 * Block numbers are below 2^53, so Number math on them is exact. No token amounts are handled here.
 */

export type ChainKey = "base" | "rh";

export interface ChainIn {
  chainId: number;
  ok: boolean;
  logsOk: boolean;
  error: string | null;
  from: string | null;
  to: string | null;
  /** Per-block gas fraction; null = unknown for that block. */
  gas: (number | null)[];
  baseFeeWei: string | null;
  anchor: { block: string; timeMs: number; exact: boolean } | null;
  cadenceMs: number;
  logsTo: string | null;
}

export interface EventIn {
  id: string;
  chainId: number;
  block: string;
  tx: string;
  logIndex: number;
  kind: string;
  contact: boolean;
  summary: string;
  spender: string | null;
  token?: string | null;
  symbol?: string | null;
  spenderLabel?: string | null;
}

export interface PulseIn {
  chains: { base: ChainIn; rh: ChainIn };
  events: EventIn[];
}

export interface Ev extends EventIn {
  t: number;
  bn: number;
  chain: ChainKey;
}

export interface ChainBuf {
  n: number[];
  t: number[];
  gas: (number | null)[];
  gaps: [number, number][];
  cadence: number;
  exact: boolean;
  /** Last response for this chain was ok (null = never seen). */
  ok: boolean | null;
  logsOk: boolean;
  /** Consecutive ok responses whose head did not advance. */
  stall: number;
  maxTo: number;
  error: string | null;
  baseFeeWei: string | null;
  /** Block ranges whose logs were read successfully (sorted, merged, pruned to the buffered window). */
  logSegs: [number, number][];
  /** Derived from logSegs: first / last block with logs read (null = none). */
  logsFrom: number | null;
  logsTo: number | null;
}

export type Notice = { type: "GAP"; chain: ChainKey; from: number; to: number };

const MAX_BLOCKS = 2_000;
const MAX_EVENTS = 600;
const BLOCK_KEEP_MS = 70_000;
const EVENT_KEEP_MS = 200_000;
export const DRY_MS = 1_500;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function newChain(): ChainBuf {
  return { n: [], t: [], gas: [], gaps: [], cadence: 0, exact: false, ok: null, logsOk: true, stall: 0, maxTo: -1, error: null, baseFeeWei: null, logSegs: [], logsFrom: null, logsTo: null };
}

/** Index of the last element ≤ x in a sorted array (−1 if none). */
export function lastLE(arr: readonly number[], x: number): number {
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

/** Index of the first element ≥ x in a sorted array (arr.length if none). */
export function firstGE(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ReplayBuffer {
  chains: Record<ChainKey, ChainBuf> = { base: newChain(), rh: newChain() };
  events: Ev[] = [];
  private ids = new Set<string>();
  private emitted = new Set<string>();
  private notices: Notice[] = [];

  clear(): void {
    this.chains = { base: newChain(), rh: newChain() };
    this.events = [];
    this.ids.clear();
    this.emitted.clear();
    this.notices = [];
  }

  newestTime(chain: ChainKey): number | null {
    const c = this.chains[chain];
    return c.t.length ? c.t[c.t.length - 1] : null;
  }

  newestBlock(chain: ChainKey): number | null {
    const c = this.chains[chain];
    return c.n.length ? c.n[c.n.length - 1] : null;
  }

  isDry(chain: ChainKey, replayNow: number): boolean {
    const t = this.newestTime(chain);
    return t === null || replayNow > t + DRY_MS;
  }

  /** Newest block time to sample the replay clock with: Base when its anchor is exact, else Robinhood. */
  leadTime(p: PulseIn): number | null {
    if (p.chains.base.ok && p.chains.base.anchor?.exact) return this.newestTime("base");
    if (p.chains.rh.ok) return this.newestTime("rh");
    if (p.chains.base.ok) return this.newestTime("base");
    return null;
  }

  drainNotices(): Notice[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  merge(p: PulseIn, replayNow = -Infinity): void {
    for (const key of ["base", "rh"] as const) this.mergeChain(key, p.chains[key]);
    this.mergeEvents(p.events);
    this.prune(replayNow);
  }

  private mergeChain(key: ChainKey, ci: ChainIn): void {
    const c = this.chains[key];
    c.ok = !!ci.ok;
    if (!ci.ok || !ci.anchor || ci.from === null || ci.to === null) {
      c.error = ci.error ?? "chain unavailable";
      c.stall = 0;
      return;
    }
    c.error = ci.logsOk ? null : ci.error;
    c.logsOk = !!ci.logsOk;
    c.baseFeeWei = ci.baseFeeWei;
    const from = Number(ci.from);
    const to = Number(ci.to);
    // The sweep only grows over windows whose getLogs succeeded; failed windows / unpolled blocks stay as gaps.
    if (ci.logsOk && ci.logsTo !== null && Number(ci.logsTo) >= from) addSeg(c, from, Number(ci.logsTo));
    if (to > c.maxTo) {
      c.stall = 0;
      c.maxTo = to;
    } else c.stall++;
    const cad = ci.cadenceMs > 0 ? ci.cadenceMs : key === "base" ? 200 : 104;
    c.cadence = cad;
    c.exact = !!ci.anchor.exact;
    const aB = Number(ci.anchor.block);
    const aT = ci.anchor.timeMs;
    const tStar = (n: number) => aT + (n - aB) * cad;
    const lo = 0.5 * cad;
    const hi = 1.5 * cad;

    if (c.n.length === 0) {
      for (let n = from; n <= to; n++) {
        const g = ci.gas[n - from] ?? null;
        const tLast = c.t.length ? c.t[c.t.length - 1] : null;
        c.n.push(n);
        c.t.push(tLast === null ? tStar(n) : tLast + clamp(tStar(n) - tLast, lo, hi));
        c.gas.push(g);
      }
      return;
    }

    // Append (n > last), ascending.
    for (let n = Math.max(from, c.n[c.n.length - 1] + 1); n <= to; n++) {
      const last = c.n[c.n.length - 1];
      const tLast = c.t[c.t.length - 1];
      const g = ci.gas[n - from] ?? null;
      let t: number;
      if (n === last + 1) t = tLast + clamp(tStar(n) - tLast, lo, hi);
      else {
        c.gaps.push([last + 1, n - 1]);
        this.notices.push({ type: "GAP", chain: key, from: last + 1, to: n - 1 });
        t = Math.max(tStar(n), tLast + lo * (n - last));
      }
      c.n.push(n);
      c.t.push(t);
      c.gas.push(g);
    }

    // Prepend (n < first), descending (a long window arriving after a short one).
    const pre: { n: number; t: number; g: number | null }[] = [];
    let first = c.n[0];
    let tFirst = c.t[0];
    for (let n = Math.min(to, first - 1); n >= from; n--) {
      const g = ci.gas[n - from] ?? null;
      let t: number;
      if (n === first - 1) t = tFirst - clamp(tFirst - tStar(n), lo, hi);
      else {
        c.gaps.push([n + 1, first - 1]);
        t = Math.min(tStar(n), tFirst - lo * (first - n));
      }
      pre.push({ n, t, g });
      first = n;
      tFirst = t;
    }
    if (pre.length) {
      pre.reverse();
      c.n = pre.map((x) => x.n).concat(c.n);
      c.t = pre.map((x) => x.t).concat(c.t);
      c.gas = pre.map((x) => x.g).concat(c.gas);
    }
  }

  private mergeEvents(events: EventIn[]): void {
    let added = false;
    for (const e of events) {
      if (this.ids.has(e.id)) continue;
      const chain: ChainKey = e.chainId === 4663 ? "rh" : "base";
      const t = this.blockTime(chain, Number(e.block));
      if (t === null) continue;
      this.ids.add(e.id);
      this.events.push({ ...e, t, bn: Number(e.block), chain });
      added = true;
    }
    if (added) this.events.sort((a, b) => a.t - b.t || a.logIndex - b.logIndex);
  }

  /** Replay time of block n: its buffered time, else the chain's formula time from the nearest buffered block. */
  blockTime(chain: ChainKey, n: number): number | null {
    const c = this.chains[chain];
    if (!c.n.length) return null;
    const i = lastLE(c.n, n);
    if (i >= 0 && c.n[i] === n) return c.t[i];
    const j = i >= 0 ? i : 0;
    return c.t[j] + (n - c.n[j]) * c.cadence;
  }

  private prune(replayNow: number): void {
    for (const key of ["base", "rh"] as const) {
      const c = this.chains[key];
      let cut = Number.isFinite(replayNow) ? firstGE(c.t, replayNow - BLOCK_KEEP_MS) : 0;
      cut = Math.max(cut, c.n.length - MAX_BLOCKS);
      // Never prune the newest block: it is the replay frontier.
      cut = Math.min(cut, Math.max(0, c.n.length - 1));
      if (cut > 0) {
        c.n.splice(0, cut);
        c.t.splice(0, cut);
        c.gas.splice(0, cut);
        const minN = c.n[0];
        c.gaps = c.gaps.filter((g) => g[1] >= minN);
      }
      if (c.n.length) {
        const minN = c.n[0];
        c.logSegs = c.logSegs.filter((sg) => sg[1] >= minN);
        if (c.logSegs.length && c.logSegs[0][0] < minN) c.logSegs[0] = [minN, c.logSegs[0][1]];
        syncSegs(c);
      }
    }
    if (Number.isFinite(replayNow)) {
      const cutoff = replayNow - EVENT_KEEP_MS;
      let k = 0;
      while (k < this.events.length && this.events[k].t < cutoff) k++;
      if (k) {
        for (const e of this.events.slice(0, k)) {
          this.ids.delete(e.id);
          this.emitted.delete(e.id);
        }
        this.events.splice(0, k);
      }
    }
    if (this.events.length > MAX_EVENTS) {
      const drop = this.events.splice(0, this.events.length - MAX_EVENTS);
      for (const e of drop) {
        this.ids.delete(e.id);
        this.emitted.delete(e.id);
      }
    }
  }

  /** Mark every event at or before t as already shown (go-live: history stays summarised, never re-streamed). */
  markEmittedUpTo(t: number): void {
    for (const e of this.events) {
      if (e.t > t) break;
      this.emitted.add(e.id);
    }
  }

  /** Is every block in [nLo, nHi] covered by a successful log read? "none" = no block of it was. */
  logCoverage(chain: ChainKey, nLo: number, nHi: number): "full" | "partial" | "none" {
    if (nHi < nLo) return "none";
    let covered = 0;
    for (const [a, b] of this.chains[chain].logSegs) {
      const lo = Math.max(a, nLo);
      const hi = Math.min(b, nHi);
      if (lo <= hi) covered += hi - lo + 1;
    }
    return covered >= nHi - nLo + 1 ? "full" : covered > 0 ? "partial" : "none";
  }

  /** Events whose replay time has been reached, each exactly once, in order. */
  eventsDue(replayNow: number): Ev[] {
    const out: Ev[] = [];
    for (const e of this.events) {
      if (e.t > replayNow) break;
      if (this.emitted.has(e.id)) continue;
      this.emitted.add(e.id);
      out.push(e);
    }
    return out;
  }

  /** Blocks of a chain with t in [lo, hi] → index range [i0, i1) (sorted arrays). */
  range(chain: ChainKey, lo: number, hi: number): [number, number] {
    const c = this.chains[chain];
    return [firstGE(c.t, lo), lastLE(c.t, hi) + 1];
  }

  /** Newest block replayed at replayNow (null = none yet). */
  replayedHead(chain: ChainKey, replayNow: number): { n: number; t: number; gas: number | null } | null {
    const c = this.chains[chain];
    const i = lastLE(c.t, replayNow);
    return i < 0 ? null : { n: c.n[i], t: c.t[i], gas: c.gas[i] };
  }

  /** Gaps (block ranges never received) intersecting [nLo, nHi]. */
  gapsIn(chain: ChainKey, nLo: number, nHi: number): number {
    let missing = 0;
    for (const [a, b] of this.chains[chain].gaps) {
      const lo = Math.max(a, nLo);
      const hi = Math.min(b, nHi);
      if (lo <= hi) missing += hi - lo + 1;
    }
    return missing;
  }
}

function syncSegs(c: ChainBuf): void {
  c.logsFrom = c.logSegs.length ? c.logSegs[0][0] : null;
  c.logsTo = c.logSegs.length ? c.logSegs[c.logSegs.length - 1][1] : null;
}

/** Insert [a, b] into the sorted, merged segment list (adjacent ranges merge). */
function addSeg(c: ChainBuf, a: number, b: number): void {
  const out: [number, number][] = [];
  let lo = a;
  let hi = b;
  let placed = false;
  for (const sg of c.logSegs) {
    if (sg[1] + 1 < lo) out.push(sg);
    else if (sg[0] > hi + 1) {
      if (!placed) {
        out.push([lo, hi]);
        placed = true;
      }
      out.push(sg);
    } else {
      lo = Math.min(lo, sg[0]);
      hi = Math.max(hi, sg[1]);
    }
  }
  if (!placed) out.push([lo, hi]);
  c.logSegs = out;
  syncSegs(c);
}

export interface SweepCounts {
  base: number;
  rh: number;
  permit2: number;
  max: number;
  revoke: number;
  vibes: number;
  /** Window [m − 60 s, m) not fully covered without gaps (blocks or logs). */
  partial: boolean;
  /** Log coverage of the minute's blocks per chain ("none" = events unavailable for that chain). */
  logs: Record<ChainKey, "full" | "partial" | "none">;
  /** Earliest replay time held in the buffer (for "watching since"). */
  since: number | null;
}

/** Real counts for the UTC minute ending at `m` (ms), from the buffer only. */
export function minuteSweep(buf: ReplayBuffer, m: number): SweepCounts {
  const lo = m - 60_000;
  const out: SweepCounts = { base: 0, rh: 0, permit2: 0, max: 0, revoke: 0, vibes: 0, partial: false, logs: { base: "none", rh: "none" }, since: null };
  for (const key of ["base", "rh"] as const) {
    const c = buf.chains[key];
    const [i0, i1] = buf.range(key, lo, m - 0.001);
    out[key] = Math.max(0, i1 - i0);
    const first = c.t.length ? c.t[0] : null;
    if (first !== null && (out.since === null || first < out.since)) out.since = first;
    const covered = first !== null && first <= lo + 1.5 * c.cadence && c.t[c.t.length - 1] >= m - 1.5 * c.cadence;
    const gapped = i1 > i0 && buf.gapsIn(key, c.n[i0], c.n[i1 - 1]) > 0;
    // Logs lag the head by a few blocks, so the newest blocks of the minute may be read in the next window.
    out.logs[key] = i1 > i0 ? buf.logCoverage(key, c.n[i0], c.n[i1 - 1]) : "none";
    if (!covered || gapped || out.logs[key] !== "full") out.partial = true;
  }
  for (const e of buf.events) {
    if (e.t < lo) continue;
    if (e.t >= m) break;
    if (e.kind === "P2_GRANT" || e.kind === "P2_MAX" || e.kind === "P2_REVOKE") {
      out.permit2++;
      if (e.kind === "P2_MAX") out.max++;
      if (e.kind === "P2_REVOKE") out.revoke++;
    } else if (e.contact) out.vibes++;
  }
  return out;
}

function p90(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * (s.length - 1) + 0.5))];
}

export const D_MIN = 1_500;
export const D_MAX = 8_000;
const POLL_MS = 1_500;
const MARGIN_MS = 300;
const SLEW = 0.04;
/** While Lε trails L by more than this, replay catches up at up to 1.25× (never freezes, never jumps). */
const CATCHUP_GAP_MS = 750;
const CATCHUP_SLEW = 0.25;
const BOOST_STEP = 400;
const BOOST_DECAY = 100;

/**
 * Skew-free replay clock. lead = newestBlockTime − clientReceiveMs (absorbs client/server clock skew and cache age);
 * sample() is fed ONLY fresh (short-window) responses. L = p90(leads); target delay
 * D* = clamp(p90(L − lead_i) + poll + margin + boost, 1.5 s, 8 s), boost += 400 per underrun and decays 100 per
 * sample. D slews by ≤ 0.04·dt; Lε slews up by ≤ 0.25·dt while it trails L by > 750 ms (catch-up ≤ 1.25×), else
 * ≤ 0.04·dt, and down by ≤ 0.04·dt — so replay runs at 0.96–1.25×, never jumps and never stalls.
 * Until lock() (called at go-live, while the face still shows the static snapshot) Lε snaps to L on every sample,
 * so a stale first response can never leave the live replay seconds behind.
 */
export class ReplayClock {
  leads: number[] = [];
  L = 0;
  Le = 0;
  D = 3_000;
  Dstar = 3_000;
  boost = 0;
  started = false;
  locked = false;
  prev = -Infinity;

  sample(newestTime: number, receiveMs: number): void {
    this.leads.push(newestTime - receiveMs);
    if (this.leads.length > 30) this.leads.shift();
    this.L = p90(this.leads);
    this.boost = Math.max(0, this.boost - BOOST_DECAY);
    const L = this.L;
    this.Dstar = clamp(p90(this.leads.map((l) => L - l)) + POLL_MS + MARGIN_MS + this.boost, D_MIN, D_MAX);
    if (!this.started) {
      this.started = true;
      this.Le = this.L;
      this.D = Math.max(3_000, this.Dstar);
      this.prev = -Infinity;
    }
    if (!this.locked) this.Le = this.L;
  }

  /** Go-live: from now on Lε only slews (the replayed instant never jumps). */
  lock(): void {
    this.locked = true;
  }

  underrun(): void {
    this.boost = Math.min(this.boost + BOOST_STEP, D_MAX);
    this.Dstar = clamp(this.Dstar + BOOST_STEP, D_MIN, D_MAX);
  }

  reset(): void {
    this.leads = [];
    this.started = false;
    this.locked = false;
    this.boost = 0;
    this.prev = -Infinity;
  }

  /** Advance by one frame (dt capped at 50 ms) and return the monotonic replay time. */
  tick(nowMs: number, dt: number): number {
    // Before the first sample nothing is recorded: a pre-start value must never hold the arm after start.
    if (!this.started) return nowMs - this.D;
    const d = Math.min(Math.max(dt, 0), 50);
    const gap = this.L - this.Le;
    this.Le += clamp(gap, -SLEW * d, (gap > CATCHUP_GAP_MS ? CATCHUP_SLEW : SLEW) * d);
    const step = SLEW * d;
    this.D += clamp(this.Dstar - this.D, -step, step);
    const rn = nowMs + this.Le - this.D;
    this.prev = Math.max(this.prev, rn);
    return this.prev;
  }
}

/** The disclosed replay delay: the real lag of the replayed instant behind the wall clock (never a target). */
export function lagLabel(nowMs: number, replayNow: number): string {
  return `T−${(Math.max(0, nowMs - replayNow) / 1000).toFixed(1)}s`;
}
