"use client";

import Link from "next/link";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Countdown } from "@/components/countdown";
import { cx, SectionLabel } from "@/components/ui";
import type { Pulse, PulseLastContact, PulseParity } from "@/lib/engine/pulse-types";
import { explorerBlock, explorerTx, fmtUnits } from "@/lib/format";
import { ago, type BlockSeries, buildFace, computeStats, type FaceData, type FaceEvent, faceDataFromPulse, FaceSvg, type FaceStats, group, hm, hms, hmsApprox, hmsd, seriesFromPulse } from "./face-svg";
import { angDist, BAND_COLOR, bearing, COLOR, CONTACT_MS, MINUTE_MS, pointerBearing, zoneAt } from "./geometry";
import { Painter } from "./painter";
import { lagLabel, minuteSweep, ReplayBuffer, ReplayClock } from "./replay";

/**
 * SENTINEL WATCH · K-60 — the landing hero's live instrument. A 60-second watch face whose arm is the UTC clock
 * (replayed a disclosed few seconds behind the newest received block). Every bar is one real Base / Robinhood
 * block (length √gasUsedRatio from eth_feeHistory), every lane mark one real Permit2 log, every contact one real
 * $VIBES / OFT / Vibestarter log. SSR renders a deterministic SNAPSHOT from props; the client then goes live.
 */

export interface WatchScan {
  score: number;
  band: "NOMINAL" | "ELEVATED" | "CRITICAL";
  block: string;
  at: number;
}
/** Server-rendered Morning Desk Brief excerpt (plain text, no motion) — Pillar 1 output for crawlers / no-JS. */
export interface WatchBrief {
  text: string | null;
  topFinding: string | null;
}
export interface WatchEscrow {
  openEndsAt: number | null;
  openLabel: string | null;
  nextTranche: number;
}

type Phase = "snapshot" | "live" | "buffering" | "offline" | "reacquiring" | "paused" | "reduced";
type Chain = "base" | "rh";

type TapeRow =
  | { key: string; type: "ev"; t: number; chainId: number; block: string; kind: string; contact: boolean; summary: string; tx: string; spender: string | null; detail: string }
  | { key: string; type: "sum"; chainId: number; from: number; to: number; text: string }
  | { key: string; type: "sys"; tag: string; text: string; crit?: boolean };

const VIBES_BASE = "0xefFC8815487084a97edfdfF968b56Ea123421Acb";
const POLL_MS = 1_500;
const FIRST_FOLLOWUP_MS = 400;
const REDUCED_POLL_MS = 10_000;
const BACKOFF = [1_500, 3_000, 6_000, 12_000, 15_000];
const CHAIN_LABEL: Record<Chain, string> = { base: "BASE", rh: "RH" };
const CHAIN_ID: Record<Chain, number> = { base: 8453, rh: 4663 };
const CHAIN_COLOR: Record<Chain, string> = { base: COLOR.base, rh: COLOR.rh };
const keyOf = (chainId: number): Chain => (chainId === 4663 ? "rh" : "base");

const CSS = `
@keyframes sw-in{from{transform:translateY(-100%);opacity:0}to{transform:none;opacity:1}}
.sw-in{animation:sw-in 180ms ease-out}
@keyframes sw-flash{from{background:var(--sw-flash)}to{background:transparent}}
.sw-flash{animation:sw-flash 600ms ease-out 1}
@media (prefers-reduced-motion: reduce){.sw-in,.sw-flash{animation:none}}
`;

function kindLabel(kind: string, contact: boolean): string {
  if (contact) return "CONTACT";
  if (kind === "P2_MAX") return "MAX GRANT";
  if (kind === "P2_REVOKE") return "REVOKE";
  if (kind === "P2_GRANT") return "GRANT";
  return kind;
}

const short = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

interface EvLike {
  id: string;
  t: number;
  chainId: number;
  block: string;
  kind: string;
  contact: boolean;
  summary: string;
  tx: string;
  spender: string | null;
  token?: string | null;
  symbol?: string | null;
  spenderLabel?: string | null;
}

/** Permit2 rows read "→ spender · token" so a narrow column truncates the token, never the spender. */
function detailOf(e: EvLike): string {
  if (e.contact || !e.kind.startsWith("P2_")) return e.summary;
  return `→ ${e.spenderLabel ?? short(e.spender)} · ${e.symbol ?? short(e.token)}`;
}

function evRow(e: EvLike): TapeRow {
  return { key: e.id, type: "ev", t: e.t, chainId: e.chainId, block: e.block, kind: e.kind, contact: e.contact, summary: e.summary, tx: e.tx, spender: e.spender, detail: detailOf(e) };
}

/** Base block times are exact (timestampMs); Robinhood's are 1 s resolution with interpolated bearings. */
const tOf = (chainId: number, t: number) => (chainId === 4663 ? hmsApprox(t) : hmsd(t));

/** Robinhood per-block gasUsed from the payload fraction (gasUsed ÷ (14M gas/s · cadence)). */
const RH_GAS_PER_SEC = 14_000_000;
function rhGasUsed(frac: number, cadenceMs: number): number {
  return Math.round(frac * RH_GAS_PER_SEC * (cadenceMs / 1000));
}
function kGas(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}
/** Mgas/s over the 10 s ending at the head, from the summed per-block fractions. */
function rhMgasPerSec(sum10: number | null, cadenceMs: number): string {
  return sum10 === null ? "—" : ((sum10 * RH_GAS_PER_SEC * (cadenceMs / 1000)) / 10 / 1e6).toFixed(1);
}
function rhShareLabel(cadenceMs: number): string {
  return `${((RH_GAS_PER_SEC * cadenceMs) / 1000 / 1e6).toFixed(2)}M`;
}

function words(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))} seconds`;
  const h = Math.floor(m / 60);
  return h ? `${h} hours ${m % 60} minutes` : `${m} minutes`;
}

function ariaSummary(
  stats: FaceStats,
  scan: WatchScan | null,
  parity: PulseParity | null,
  lc: PulseLastContact | null,
  nowMs: number,
  live: boolean,
  noLogs: Record<Chain, boolean> = { base: false, rh: false }
): string {
  const ch = (name: string, c: FaceStats["base"]) => (c.head === null ? `${name} unavailable` : `${name} block ${group(c.head)}${c.perSec !== null ? ` at ${c.perSec.toFixed(1)} blocks per second` : ""}`);
  const p2 =
    noLogs.base && noLogs.rh
      ? "Permit2 events unavailable on both chains"
      : `last ${stats.coverageSec || 60} seconds: ${stats.p2.total} Permit2 allowance events, ${stats.p2.max} unlimited, ${stats.p2.revokes} revokes${noLogs.base ? " (Base events unavailable)" : noLogs.rh ? " (Robinhood Chain events unavailable)" : ""}`;
  const parts = [
    `Sentinel watch, ${live ? "live" : "snapshot"}: ${ch("Base", stats.base)}; ${ch("Robinhood Chain", stats.rh)}`,
    p2,
    scan ? `$VIBES threat ${scan.score} of 100, ${scan.band.toLowerCase()}` : "$VIBES threat scan unavailable",
    `OFT parity ${parity ? parity.status.toLowerCase() : "unknown"}`,
  ];
  if (lc?.contact) parts.push(`last $VIBES contact ${words(nowMs - lc.contact.timestamp * 1000)} ago`);
  else if (lc) parts.push("no $VIBES contact in the scanned range");
  return parts.join("; ") + ".";
}

export function SentinelWatchLive({ initial, scan, escrow, brief, nowSec }: { initial: Pulse | null; scan: WatchScan | null; escrow: WatchEscrow | null; brief?: WatchBrief | null; nowSec: number }) {
  // ── deterministic snapshot (SSR + hydration): no wall clock, no randomness, en-US grouping, ISO slices ──────
  const snap = useMemo(() => {
    if (!initial) return null;
    const { chains, nowT, timeOf } = seriesFromPulse(initial);
    if (nowT === null) return null;
    const events: (FaceEvent & Pulse["events"][number])[] = [];
    for (const e of initial.events) {
      const t = timeOf(keyOf(e.chainId), Number(e.block));
      if (t !== null) events.push({ ...e, t, chain: keyOf(e.chainId) });
    }
    const stats = computeStats(chains, events, nowT);
    const face = faceDataFromPulse(initial, scan);
    const recent = events.filter((e) => e.t <= nowT).slice(-4).reverse();
    const noLogs = { base: !!initial.chains.base.ok && !initial.chains.base.logsOk, rh: !!initial.chains.rh.ok && !initial.chains.rh.logsOk };
    const sum = `LAST 60 S · BASE ${stats.base.head !== null ? group(stats.base.bars60) : "—"} blk · RH ${stats.rh.head !== null ? group(stats.rh.bars60) : "—"} blk · PERMIT2 ${stats.p2.total} (${stats.p2.max} MAX) · $VIBES ${stats.vibes}${noLogs.base ? " · BASE — events unavailable" : ""}${noLogs.rh ? " · RH — events unavailable" : ""}`;
    const tape: TapeRow[] = [{ key: "snap-sum", type: "sys", tag: "SNAPSHOT", text: sum }, ...recent.map((e) => evRow({ ...e }))];
    return { chains, nowT, events, stats, face, tape, noLogs };
  }, [initial, scan]);

  const initialLc = initial?.lastContact ?? null;
  const builtAt = initial?.builtAt ?? 0;

  const [phase, setPhase] = useState<Phase>("snapshot");
  const [offlineN, setOfflineN] = useState(0);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tape, setTape] = useState<TapeRow[]>(() => snap?.tape ?? []);
  const [lc, setLc] = useState<PulseLastContact | null>(initialLc);
  const [parity, setParity] = useState<PulseParity | null>(initial?.parity ?? null);
  const [reducedFace, setReducedFace] = useState<FaceData | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const figRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const delayRef = useRef<HTMLSpanElement>(null);
  const headRef = { base: useRef<HTMLAnchorElement>(null), rh: useRef<HTMLAnchorElement>(null) };
  const subWideRef = { base: useRef<HTMLSpanElement>(null), rh: useRef<HTMLSpanElement>(null) };
  const subCompactRef = { base: useRef<HTMLSpanElement>(null), rh: useRef<HTMLSpanElement>(null) };
  const warnRef = { base: useRef<HTMLSpanElement>(null), rh: useRef<HTMLSpanElement>(null) };
  const p2TitleRef = useRef<HTMLSpanElement>(null);
  const p2BaseRef = useRef<HTMLSpanElement>(null);
  const p2RhRef = useRef<HTMLSpanElement>(null);
  const p2RevRef = useRef<HTMLSpanElement>(null);
  const capRef = useRef<HTMLSpanElement>(null);
  const parityAgoRef = useRef<HTMLSpanElement>(null);
  const quietRef = useRef<HTMLSpanElement>(null);
  const watchedRef = useRef<HTMLSpanElement>(null);
  const sweepRef = useRef<HTMLSpanElement>(null);
  const captionRef = useRef<HTMLElement>(null);
  const liveRegionRef = useRef<HTMLParagraphElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipTextRef = useRef<HTMLSpanElement>(null);
  const tipLinkRef = useRef<HTMLAnchorElement>(null);
  const pausedRef = useRef(false);
  const lcRef = useRef<PulseLastContact | null>(initialLc);
  const parityRef = useRef<PulseParity | null>(initial?.parity ?? null);
  const engineRef = useRef<{ resume: () => void; pause: () => void } | null>(null);
  const cleanups = useRef<(() => void)[]>([]).current;

  useEffect(() => {
    lcRef.current = lc;
  }, [lc]);
  useEffect(() => {
    parityRef.current = parity;
  }, [parity]);

  // ── the engine ───────────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = rootRef.current;
    const fig = figRef.current;
    const canvas = canvasRef.current;
    if (!root || !fig || !canvas) return;
    const rootEl: HTMLElement = root;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

    const buf = new ReplayBuffer();
    const clock = new ReplayClock();
    let painter: Painter | null = null;
    let disposed = false;
    let rafId = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;
    let onscreen = true;
    let fails = 0;
    let lastSuccess = Date.now();
    let lastActive = Date.now();
    let offline = false;
    let isLive = false;
    let curPhase: Phase = "snapshot";
    let rn = snap?.nowT ?? Date.now();
    let lastTs = 0;
    let lastPaint = 0;
    let t100 = 0;
    let t250 = 0;
    let t500 = 0;
    let t1000 = 0;
    let seq = 0;
    let shown = false;
    let dryAt: number | null = null;
    const underrun: Record<Chain, boolean> = { base: false, rh: false };
    let bars = 0;
    let frames = 0;
    let watchStarted = false;
    let reducedMarked = false;
    /** Set on resume(): the first post-suspension gap is expected, not an underrun (no BUFFERING, no boost). */
    let grace = false;
    let lastMinute: number | null = null;
    let lastParityAt = parityRef.current?.fetchedAt ?? null;
    const chainLost: Record<Chain, boolean> = { base: false, rh: false };
    const lastOkHead: Record<Chain, { n: number; at: number } | null> = { base: null, rh: null };
    let gapSinceLost = 0;
    let lastAnnounce = 0;
    const queue: TapeRow[] = [];
    let ariaAt = 0;
    let fps30 = coarse || saveData;

    const setP = (p: Phase) => {
      if (curPhase === p) return;
      curPhase = p;
      setPhase(p);
      rootEl.dataset.state = p;
    };
    const announce = (msg: string) => {
      const now = Date.now();
      if (now - lastAnnounce < 30_000 || !liveRegionRef.current) return;
      lastAnnounce = now;
      liveRegionRef.current.textContent = msg;
    };
    const sys = (tag: string, text: string, crit = false) => queue.push({ key: `sys-${tag}`, type: "sys", tag, text, crit });

    // ── network ──
    const active = () => !disposed && !document.hidden && onscreen && !pausedRef.current;
    async function fetchPulse(span: "short" | "long"): Promise<void> {
      const c = new AbortController();
      ctrl = c;
      const to = setTimeout(() => c.abort(), span === "long" ? 8_000 : 4_000);
      try {
        const res = await fetch(span === "long" ? "/api/pulse?span=long" : "/api/pulse", { cache: "no-store", signal: c.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = (await res.json()) as Pulse;
        if (disposed || !p?.chains) throw new Error("bad body");
        onPulse(p, Date.now(), span);
      } finally {
        clearTimeout(to);
      }
    }

    function onPulse(p: Pulse, receive: number, span: "short" | "long") {
      buf.merge(p, Number.isFinite(rn) ? rn : -Infinity);
      // Only fresh (short) responses drive the replay clock: a CDN/memo-cached long window is seconds older and
      // would hold the arm; long responses only add history.
      if (span === "short") {
        const lt = buf.leadTime(p);
        if (lt !== null) clock.sample(lt, receive);
        grace = false;
      }
      for (const n of buf.drainNotices()) {
        const cnt = n.to - n.from + 1;
        if (offline) gapSinceLost += cnt;
        else sys("GAP", `GAP · ${CHAIN_LABEL[n.chain]} ${group(cnt)} blocks not received (#${group(n.from)}–#${group(n.to)})`);
      }
      for (const ch of ["base", "rh"] as const) {
        const ok = p.chains[ch].ok;
        if (!ok && !chainLost[ch]) {
          chainLost[ch] = true;
          sys("SIGNAL", `${CHAIN_LABEL[ch]} SIGNAL LOST · ${p.chains[ch].error ?? "RPC unavailable"}`, true);
          announce(`${ch === "base" ? "Base" : "Robinhood Chain"} feed lost.`);
        } else if (ok && chainLost[ch]) {
          chainLost[ch] = false;
          sys("SIGNAL", `${CHAIN_LABEL[ch]} SIGNAL RESTORED`);
          announce(`${ch === "base" ? "Base" : "Robinhood Chain"} feed restored.`);
        }
        if (ok) {
          const nb = buf.newestBlock(ch);
          if (nb !== null) lastOkHead[ch] = { n: nb, at: receive };
        }
      }
      if (p.parity && p.parity.fetchedAt !== lastParityAt) {
        const prev = parityRef.current;
        lastParityAt = p.parity.fetchedAt;
        parityRef.current = p.parity;
        setParity(p.parity);
        sys("PARITY", `OFT 1:1 ${p.parity.status}${p.parity.deltaRaw !== null ? ` · Δ ${fmtUnits(p.parity.deltaRaw, 18)}` : ""} · BASE #${p.parity.baseBlock ? group(p.parity.baseBlock) : "—"} · RH #${p.parity.rhBlock ? group(p.parity.rhBlock) : "—"}`);
        if (prev && prev.status !== p.parity.status && (p.parity.status === "DRIFT" || prev.status === "DRIFT")) announce(`OFT parity ${p.parity.status.toLowerCase()}.`);
      }
      if (p.lastContact && JSON.stringify(p.lastContact.contact) !== JSON.stringify(lcRef.current?.contact ?? null)) {
        lcRef.current = p.lastContact;
        setLc(p.lastContact);
      } else if (p.lastContact && !lcRef.current) {
        lcRef.current = p.lastContact;
        setLc(p.lastContact);
      }
      fails = 0;
      lastSuccess = Date.now();
      if (offline) {
        offline = false;
        sys("SIGNAL", `SIGNAL RESTORED · ${group(gapSinceLost)} blocks not received`);
        gapSinceLost = 0;
        announce("Live feed restored.");
      }
    }

    function markOffline() {
      if (offline || disposed) return;
      offline = true;
      gapSinceLost = 0;
      sys("SIGNAL LOST", `SIGNAL LOST ${hms(Date.now())} UTC`, true);
      announce("Live feed lost; reconnecting.");
    }

    function schedule(ms: number) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, ms);
    }
    async function poll() {
      pollTimer = null;
      if (!active()) return;
      try {
        await fetchPulse("short");
        // reduced motion: the static face is re-rendered from each fresh response (not on a separate timer that
        // could fire just before the data lands)
        if (reduced) renderReduced();
        schedule(reduced ? REDUCED_POLL_MS : POLL_MS);
      } catch {
        if (disposed) return;
        fails++;
        setOfflineN(fails);
        if (fails >= 3 || Date.now() - lastSuccess > 10_000) markOffline();
        schedule(reduced ? REDUCED_POLL_MS : BACKOFF[Math.min(fails - 1, BACKOFF.length - 1)]);
      }
    }

    async function acquire(clear: boolean) {
      if (clear) {
        buf.clear();
        clock.reset();
        isLive = false;
        watchStarted = false;
        reducedMarked = false;
        lastMinute = null;
        setP("reacquiring");
      }
      try {
        await Promise.all([fetchPulse("long").catch(() => {}), fetchPulse("short")]);
        if (isLive) buf.markEmittedUpTo(rn);
        // a quick second fresh sample lets the clock lock and go live without waiting a full poll period
        schedule(reduced ? REDUCED_POLL_MS : FIRST_FOLLOWUP_MS);
      } catch {
        fails++;
        setOfflineN(fails);
        schedule(BACKOFF[Math.min(fails - 1, BACKOFF.length - 1)]);
      }
      if (reduced) renderReduced();
    }

    // ── reduced motion: no canvas, no rAF; FaceSvg re-rendered from the buffer every 10 s ──
    function renderReduced() {
      if (disposed) return;
      const t = buf.newestTime("base") ?? buf.newestTime("rh");
      if (t === null) return;
      rn = t;
      if (!reducedMarked) {
        // history up to the first replayed instant stays summarised by the SNAPSHOT row
        buf.markEmittedUpTo(rn);
        reducedMarked = true;
      }
      setReducedFace(buildFace({ chains: buf.chains, events: buf.events, nowT: t, lost: { base: buf.chains.base.ok === false, rh: buf.chains.rh.ok === false }, score: scan?.score ?? null, band: scan?.band ?? null }));
      setP(offline ? "offline" : "reduced");
      updateText(Date.now(), true);
    }

    // ── text (refs + textContent; no React render per frame) ──
    function stats(): FaceStats {
      return computeStats(buf.chains as Record<Chain, BlockSeries>, buf.events, rn);
    }
    function updateHeads(st: FaceStats) {
      for (const ch of ["base", "rh"] as const) {
        const s = st[ch];
        const a = headRef[ch].current;
        if (a && s.head !== null) {
          a.textContent = `#${group(s.head)}`;
          a.href = explorerBlock(CHAIN_ID[ch], s.head);
        }
        if (s.head !== null) rootEl.dataset[ch === "base" ? "headBase" : "headRh"] = String(s.head);
        const c = buf.chains[ch];
        const fee = c.baseFeeWei ? fmtUnits(c.baseFeeWei, 9, 3) : "—";
        const ps = s.perSec !== null ? s.perSec.toFixed(1) : "—";
        const gp = ch === "rh" ? `${rhMgasPerSec(s.gasSum10, c.cadence || 104)} Mgas/s` : `gas ${s.gasPct !== null ? `${s.gasPct.toFixed(0)}%` : "—"}`;
        if (subWideRef[ch].current) subWideRef[ch].current.textContent = `${ps} blk/s · ${gp} · ${fee} gwei`;
        if (subCompactRef[ch].current) subCompactRef[ch].current.textContent = `${ps}/s · ${gp}`;
        let warn: string | null = null;
        if (c.ok === false) {
          const h = lastOkHead[ch];
          warn = `SIGNAL LOST${h ? ` · last #${group(h.n)} · ${ago(Date.now() - h.at)} ago` : ""}${pollTimer ? " · retrying" : ""}`;
        } else if (c.stall >= 4 && c.maxTo >= 0) warn = `HEAD STALLED AT #${group(c.maxTo)}`;
        else if (isLive && !grace && buf.isDry(ch, rn) && !buf.isDry(ch === "base" ? "rh" : "base", rn)) warn = "BUFFERING";
        else if (c.ok && !c.logsOk) warn = "EVENTS UNAVAILABLE";
        const w = warnRef[ch].current;
        if (w) {
          w.hidden = !warn;
          if (warn) w.textContent = warn;
          if (subWideRef[ch].current) subWideRef[ch].current.parentElement!.hidden = !!warn;
        }
      }
    }
    function updateRails(st: FaceStats) {
      const cov = st.coverageSec;
      if (p2TitleRef.current) p2TitleRef.current.textContent = `PERMIT2 · ${cov >= 60 ? 60 : cov} S`;
      const nl = noLogs();
      const bTxt = nl.base ? "BASE — events unavailable" : `BASE ${st.p2.base} · ${st.p2.baseMax} MAX`;
      const rTxt = nl.rh ? "RH — events unavailable" : `RH ${st.p2.rh} · ${st.p2.rhMax} MAX`;
      if (p2BaseRef.current) p2BaseRef.current.textContent = bTxt;
      if (p2RhRef.current) p2RhRef.current.textContent = rTxt;
      if (p2RevRef.current) p2RevRef.current.textContent = nl.base && nl.rh ? "REVOKES —" : `REVOKES ${st.p2.revokes}`;
      const par = parityRef.current;
      if (capRef.current)
        capRef.current.textContent = `PERMIT2 ${cov >= 60 ? 60 : cov}S · ${nl.base ? "BASE — events unavailable" : `BASE ${st.p2.base}/${st.p2.baseMax} MAX`} · ${nl.rh ? "RH — events unavailable" : `RH ${st.p2.rh}/${st.p2.rhMax} MAX`} · OFT 1:1 ${par?.status ?? "UNKNOWN"}`;
      rootEl.dataset.ticks = String(bars);
      rootEl.dataset.frames = String(frames);
      const b = buf.chains.base;
      const r = buf.chains.rh;
      const sw = (c: typeof b) => {
        if (c.ok && !c.logsOk) return "— events unavailable";
        if (c.logsFrom === null) return "—";
        const gaps = c.logSegs.length - 1;
        return `#${group(c.logsFrom)}–#${group(c.logsTo ?? 0)}${gaps > 0 ? ` (${gaps} gap${gaps > 1 ? "s" : ""})` : ""}`;
      };
      if (sweepRef.current && (b.ok !== null || r.ok !== null))
        sweepRef.current.textContent = `sweep BASE ${sw(b)} · RH ${sw(r)} · RH bearings interpolated (${r.cadence ? r.cadence.toFixed(0) : "—"} ms cadence)`;
    }
    function noLogs(): Record<Chain, boolean> {
      return { base: buf.chains.base.ok === true && !buf.chains.base.logsOk, rh: buf.chains.rh.ok === true && !buf.chains.rh.logsOk };
    }
    function updateText(now: number, slow: boolean) {
      const st = stats();
      updateHeads(st);
      // the disclosed delay is the REAL lag of the replayed instant behind the wall clock
      if (delayRef.current && isLive) delayRef.current.textContent = lagLabel(now, rn);
      // register: blocks watched since the last contact tick with every replayed block of that chain
      const l = lcRef.current;
      if (l?.contact && watchedRef.current) {
        const head = st[keyOf(l.contact.chainId)].head;
        if (head !== null) watchedRef.current.textContent = group(Math.max(0, head - Number(l.contact.block)));
      }
      if (slow) {
        if (clockRef.current) clockRef.current.textContent = `${hms(rn)} UTC`;
        if (quietRef.current && l?.contact) quietRef.current.textContent = ago(now - l.contact.timestamp * 1000);
        const par = parityRef.current;
        if (parityAgoRef.current && par) parityAgoRef.current.textContent = `read ${ago(now - Date.parse(par.fetchedAt))} ago ↗`;
        updateRails(st);
        if (now - ariaAt > 10_000) {
          ariaAt = now;
          const txt = ariaSummary(st, scan, parityRef.current, lcRef.current, now, true, noLogs());
          fig?.setAttribute("aria-label", txt);
          if (captionRef.current) captionRef.current.textContent = txt;
        }
      }
    }

    // ── tape ──
    function pumpTape(now: number) {
      // Nothing streams before go-live: earlier history is summarised by the SNAPSHOT row (markEmittedUpTo).
      if (reduced ? !reducedMarked : !isLive) return;
      // system rows that depend on replay time
      const head = { base: buf.replayedHead("base", rn), rh: buf.replayedHead("rh", rn) };
      if (!watchStarted && (head.base || head.rh)) {
        watchStarted = true;
        sys("WATCH", `WATCH STARTED ${hms(rn)} UTC · BASE ${head.base ? `#${group(head.base.n)}` : "—"} · RH ${head.rh ? `#${group(head.rh.n)}` : "—"}`);
        lastMinute = Math.floor(rn / MINUTE_MS);
      }
      if (watchStarted) {
        const m = Math.floor(rn / MINUTE_MS);
        if (lastMinute !== null && m > lastMinute) {
          const s = minuteSweep(buf, m * MINUTE_MS);
          const na = (["base", "rh"] as const).filter((k) => s[k] > 0 && s.logs[k] === "none").map((k) => `${CHAIN_LABEL[k]} — events unavailable`);
          sys(
            "SWEEP",
            `SWEEP ${hm((m - 1) * MINUTE_MS)} · BASE ${group(s.base)} blk · RH ${group(s.rh)} blk · PERMIT2 ${s.permit2} (${s.max} MAX, ${s.revoke} REVOKE) · $VIBES ${s.vibes}${na.length ? ` · ${na.join(" · ")}` : ""}${s.partial ? ` (partial · watching since ${s.since !== null ? hms(s.since) : "—"})` : ""}`
          );
        }
        lastMinute = m;
      }
      for (const e of buf.eventsDue(rn)) {
        queue.push(evRow(e));
        if (e.contact) announce(`$VIBES contact on ${e.chain === "base" ? "Base" : "Robinhood Chain"}: ${e.summary}, block ${group(e.bn)}.`);
      }
      if (!queue.length) return;
      let next: TapeRow;
      if (queue.length > 4) {
        const older = queue.splice(0, queue.length - 2);
        const evs = older.filter((r): r is Extract<TapeRow, { type: "ev" }> => r.type === "ev");
        const sysRows = older.filter((r) => r.type !== "ev");
        queue.unshift(...sysRows.slice(-1));
        // one collapsed row per chain: "+N PERMIT2 · CHAIN #a–#b ↗" (block numbers never mixed across chains)
        for (const chainId of [4663, 8453]) {
          const rows = evs.filter((r) => r.chainId === chainId);
          if (!rows.length) continue;
          const ns = rows.map((r) => Number(r.block));
          const contacts = rows.filter((r) => r.contact).length;
          queue.unshift({
            key: `sum-${rows[0].key}`,
            type: "sum",
            chainId,
            from: Math.min(...ns),
            to: Math.max(...ns),
            text: `+${rows.length - contacts} PERMIT2${contacts ? ` +${contacts} $VIBES` : ""} · ${CHAIN_LABEL[keyOf(chainId)]} #${group(Math.min(...ns))}${Math.max(...ns) > Math.min(...ns) ? `–#${group(Math.max(...ns))}` : ""}`,
          });
        }
      }
      const raw = queue.shift()!;
      next = { ...raw, key: `${raw.key}#${seq++}` };
      void now;
      setTape((rows) => [next, ...rows].slice(0, 6));
      if (next.type === "ev" && next.contact) setFlashKey(next.key);
    }

    // ── frame loop ──
    function frame(ts: number) {
      rafId = requestAnimationFrame(frame);
      if (fps30 && ts - lastPaint < 30) return;
      lastPaint = ts;
      const dt = lastTs ? ts - lastTs : 16;
      lastTs = ts;
      frames++;
      const now = Date.now();
      rn = clock.tick(now, dt);

      // go-live needs two fresh samples (a stale first one is corrected while the snapshot is still showing)
      if (!isLive && clock.started && clock.leads.length >= 2) {
        const ahead = (["base", "rh"] as const).some((ch) => {
          const t = buf.newestTime(ch);
          return t !== null && t - rn >= 1_000;
        });
        if (ahead) {
          isLive = true;
          shown = true;
          clock.lock();
          // the tape streams only events replayed after WATCH STARTED; the SNAPSHOT row summarises the rest
          buf.markEmittedUpTo(rn);
          setLive(true);
          setTimeout(() => {
            if (svgWrapRef.current) svgWrapRef.current.style.visibility = "hidden";
          }, 320);
        }
      }

      // buffering: every ok chain dry → marks freeze, the arm keeps turning
      const okChains = (["base", "rh"] as const).filter((ch) => buf.chains[ch].ok);
      for (const ch of okChains) {
        const dry = buf.isDry(ch, rn);
        if (dry && !underrun[ch] && isLive && !grace) {
          underrun[ch] = true;
          clock.underrun();
        } else if (!dry) underrun[ch] = false;
      }
      const allDry = okChains.length > 0 && okChains.every((ch) => buf.isDry(ch, rn));
      if (allDry && isLive && !grace) dryAt ??= rn;
      else dryAt = null;
      if (!offline && Date.now() - lastSuccess > 10_000) markOffline();

      if (offline) setP("offline");
      else if (!isLive) {
        if (curPhase !== "reacquiring") setP("snapshot");
      }
      else if (dryAt !== null) setP("buffering");
      else setP("live");

      if (painter && shown) bars = painter.frame(buf, rn, { lost: { base: buf.chains.base.ok === false, rh: buf.chains.rh.ok === false }, dim: offline, marksAt: dryAt });

      if (ts - t100 >= 100) {
        t100 = ts;
        updateText(now, ts - t1000 >= 1_000);
        if (ts - t1000 >= 1_000) t1000 = ts;
      }
      if (ts - t250 >= 250) {
        t250 = ts;
        pumpTape(now);
      }
      if (ts - t500 >= 500) {
        t500 = ts;
        rootEl.dataset.ticks = String(bars);
        rootEl.dataset.frames = String(frames);
      }
    }

    function startLoop() {
      if (reduced || rafId || !active()) return;
      lastTs = 0;
      rafId = requestAnimationFrame(frame);
    }
    function stopLoop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      rootEl.dataset.frames = String(frames);
    }
    function stopPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      ctrl?.abort();
    }

    function suspend() {
      lastActive = Date.now();
      stopLoop();
      stopPolling();
    }
    function resume() {
      if (!active()) return;
      const away = Date.now() - lastActive;
      // Time spent hidden / offscreen / paused is not a network failure.
      lastSuccess = Date.now();
      fails = 0;
      grace = true;
      if (away > 10_000) void acquire(true);
      else if (!pollTimer) schedule(0);
      startLoop();
      if (reduced) setP(offline ? "offline" : "reduced");
    }

    // ── canvas ──
    if (!reduced) {
      try {
        painter = new Painter(canvas, getComputedStyle(canvas).fontFamily || "monospace");
      } catch {
        painter = null;
      }
      const ro = new ResizeObserver(() => {
        const size = fig.clientWidth;
        if (!painter || !size) return;
        fps30 = coarse || saveData || size < 400;
        painter.resize(size, window.devicePixelRatio, scan?.score ?? null, scan?.band ?? null);
      });
      ro.observe(fig);
      cleanups.push(() => ro.disconnect());
    }

    // ── hover / click hit-test (rAF-throttled) ──
    let hoverReq = 0;
    let hoverUrl: string | null = null;
    let lastPointer: { x: number; y: number; type: string } | null = null;
    function hitTest() {
      hoverReq = 0;
      const tip = tipRef.current;
      if (!lastPointer || !tip || !tipTextRef.current || !tipLinkRef.current) return;
      const rect = fig!.getBoundingClientRect();
      const R = rect.width / 2;
      const dx = lastPointer.x - rect.left - R;
      const dy = lastPointer.y - rect.top - R;
      const rPx = Math.hypot(dx, dy);
      const zone = zoneAt(rPx / R);
      const useBuf = isLive || (reduced && buf.chains.base.n.length > 0);
      const now = useBuf ? rn : (snap?.nowT ?? rn);
      const src = useBuf ? { chains: buf.chains as Record<Chain, BlockSeries>, events: buf.events as (FaceEvent & { tx: string; block: string; summary: string; chainId: number })[] } : snap ? { chains: snap.chains, events: snap.events } : null;
      if (!zone || !src) {
        tip.hidden = true;
        hoverUrl = null;
        return;
      }
      const ang = pointerBearing(dx, dy);
      const tol = Math.max(0.004, 2 / Math.max(1, rPx));
      let text: string | null = null;
      let url: string | null = null;
      // contacts first (any zone), then lane events, then blocks
      let best = tol;
      for (const e of src.events) {
        if (e.t > now || now - e.t > (e.contact ? CONTACT_MS : MINUTE_MS)) continue;
        if (!e.contact && (!zone.lane || e.chain !== zone.chain)) continue;
        const d = angDist(bearing(e.t), ang);
        if (d <= best) {
          best = d;
          text = `${CHAIN_LABEL[e.chain]} #${group(e.block)} · ${e.summary} · ${tOf(e.chainId, e.t)} UTC · click → tx`;
          url = explorerTx(e.chainId, e.tx);
        }
      }
      if (!text && !zone.lane) {
        const s = src.chains[zone.chain];
        let bi = -1;
        best = tol;
        for (let i = s.t.length - 1; i >= 0; i--) {
          const t = s.t[i];
          if (t > now) continue;
          if (now - t > MINUTE_MS) break;
          const d = angDist(bearing(t), ang);
          if (d <= best) {
            best = d;
            bi = i;
          }
        }
        if (bi >= 0) {
          const g = s.gas[bi];
          const cad = (useBuf ? buf.chains.rh.cadence : initial?.chains.rh.cadenceMs) || 104;
          const gasTxt = g === null || g === undefined ? "gas n/a" : zone.chain === "rh" ? `${kGas(rhGasUsed(g, cad))} gas` : `gas ${(g * 100).toFixed(2)}%`;
          text = `${CHAIN_LABEL[zone.chain]} #${group(s.n[bi])} · ${gasTxt} · ${tOf(CHAIN_ID[zone.chain], s.t[bi])} UTC · click → ${zone.chain === "base" ? "basescan" : "blockscout"}`;
          url = explorerBlock(CHAIN_ID[zone.chain], s.n[bi]);
        }
      }
      if (!text || !url) {
        tip.hidden = true;
        hoverUrl = null;
        return;
      }
      hoverUrl = url;
      tipTextRef.current.textContent = text;
      tipLinkRef.current.href = url;
      tip.hidden = false;
      const lx = lastPointer.x - rect.left;
      const ly = lastPointer.y - rect.top;
      tip.style.left = `${Math.max(4, Math.min(rect.width - tip.offsetWidth - 4, lx - tip.offsetWidth / 2))}px`;
      tip.style.top = `${ly > rect.height / 2 ? ly - tip.offsetHeight - 12 : ly + 14}px`;
    }
    const onMove = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY, type: e.pointerType };
      if (!hoverReq) hoverReq = requestAnimationFrame(hitTest);
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && tipRef.current) {
        lastPointer = null;
        tipRef.current.hidden = true;
        hoverUrl = null;
      }
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("a")) return;
      const pt = (e as PointerEvent).pointerType;
      lastPointer = { x: e.clientX, y: e.clientY, type: pt || "mouse" };
      hitTest();
      // coarse pointers: the first tap shows the tooltip (which carries the link)
      if (pt === "touch" || pt === "pen" || coarse) return;
      if (hoverUrl) window.open(hoverUrl, "_blank", "noopener");
    };
    fig.addEventListener("pointermove", onMove);
    fig.addEventListener("pointerleave", onLeave);
    fig.addEventListener("click", onClick);

    // ── visibility / offscreen ──
    const onVis = () => (document.hidden ? suspend() : resume());
    document.addEventListener("visibilitychange", onVis);
    const io = new IntersectionObserver(
      ([entry]) => {
        const was = onscreen;
        onscreen = entry.isIntersecting;
        if (was && !onscreen) suspend();
        else if (!was && onscreen) resume();
      },
      { threshold: 0.1 }
    );
    io.observe(root);

    engineRef.current = {
      pause: () => {
        suspend();
        setP("paused");
      },
      resume: () => {
        setP(isLive ? "live" : reduced ? "reduced" : "snapshot");
        resume();
      },
    };

    // ── go ──
    if (reduced) {
      void acquire(false).then(() => setP("reduced"));
      const slow = setInterval(() => {
        if (!active()) return;
        if (!offline && Date.now() - lastSuccess > 10_000 + REDUCED_POLL_MS) markOffline();
        updateText(Date.now(), true);
        pumpTape(Date.now());
      }, 1_000);
      cleanups.push(() => clearInterval(slow));
    } else {
      void acquire(false);
      startLoop();
    }

    return () => {
      disposed = true;
      stopLoop();
      stopPolling();
      if (hoverReq) cancelAnimationFrame(hoverReq);
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
      fig.removeEventListener("pointermove", onMove);
      fig.removeEventListener("pointerleave", onLeave);
      fig.removeEventListener("click", onClick);
      for (const c of cleanups.splice(0)) c();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) engineRef.current?.pause();
    else engineRef.current?.resume();
  };

  // ── render ───────────────────────────────────────────────────────────────────────────────────────────────
  const st = snap?.stats ?? null;
  const face = reducedFace ?? snap?.face ?? null;
  const snapT = snap?.nowT ?? null;
  const base = initial?.chains.base ?? null;
  const rh = initial?.chains.rh ?? null;
  const bandColor = scan ? BAND_COLOR[scan.band] : COLOR.ink3;
  const scanAgoMin = scan && builtAt ? Math.max(0, Math.round((builtAt / 1000 - scan.at) / 60)) : null;
  const ariaInit = st ? ariaSummary(st, scan, initial?.parity ?? null, initialLc, builtAt, false, snap?.noLogs) : "Sentinel watch: signal lost at snapshot; live feed reconnecting.";
  const rhCad = rh?.cadenceMs || 104;
  const snapNoLogs = snap?.noLogs ?? { base: false, rh: false };

  const chip = (() => {
    switch (phase) {
      case "live":
        return (
          <span className="text-phosphor" title="Replaying real blocks this far behind the wall clock">
            ● LIVE · <span ref={delayRef}>T−…</span>
          </span>
        );
      case "buffering":
        return <span className="text-warn">● BUFFERING</span>;
      case "offline":
        return (
          <span className="text-crit" title="Signal lost; reconnecting">
            ● LOST · RETRY {offlineN}
          </span>
        );
      case "reacquiring":
        return <span className="text-ink-2 cursor-blink">● REACQUIRING</span>;
      case "paused":
        return <span className="text-ink-2">❚❚ PAUSED</span>;
      case "reduced":
        return <span className="text-phosphor">● LIVE · UPDATES EVERY 10 S</span>;
      default:
        return (
          <span className="text-ink-3">● SNAPSHOT</span>
        );
    }
  })();

  const strip = (ch: Chain) => {
    const c = ch === "base" ? base : rh;
    const s = st?.[ch] ?? null;
    const fee = c?.baseFeeWei ? fmtUnits(c.baseFeeWei, 9, 3) : "—";
    const ps = s?.perSec != null ? s.perSec.toFixed(1) : "—";
    const gp = ch === "rh" ? `${rhMgasPerSec(s?.gasSum10 ?? null, rhCad)} Mgas/s` : `gas ${s?.gasPct != null ? `${s.gasPct.toFixed(0)}%` : "—"}`;
    const lost = !c?.ok;
    return (
      <div className={cx("min-w-0 px-4 py-2 max-[601px]:px-3", ch === "rh" && "border-l hairline")}>
        <p className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CHAIN_COLOR[ch] }} />
          {ch === "base" ? "BASE 8453" : "RH 4663"}
        </p>
        <a
          ref={headRef[ch]}
          href={s?.head != null ? explorerBlock(CHAIN_ID[ch], s.head) : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block text-[13px] text-ink hover:underline"
        >
          {s?.head != null ? `#${group(s.head)}` : "—"}
        </a>
        <p className="truncate text-[10px] text-ink-2">
          <span hidden={lost}>
            <span ref={subWideRef[ch]} className="hidden @min-[560px]:inline">
              {ps} blk/s · {gp} · {fee} gwei
            </span>
            <span ref={subCompactRef[ch]} className="@min-[560px]:hidden">
              {ps}/s · {gp}
            </span>
          </span>
          <span ref={warnRef[ch]} hidden={!lost} className="text-warn">
            {lost ? `SIGNAL LOST AT SNAPSHOT${c?.error ? ` · ${c.error.slice(0, 60)}` : ""}` : ""}
          </span>
        </p>
      </div>
    );
  };

  const parityTone = parity?.status === "VERIFIED" ? "text-phosphor" : parity?.status === "DRIFT" ? "text-crit" : "text-ink-3";
  const parityText = parity ? (parity.status === "UNKNOWN" ? "UNKNOWN" : `${parity.status} · Δ ${parity.deltaRaw !== null ? fmtUnits(parity.deltaRaw, 18) : "—"}`) : "UNKNOWN";
  const parityAgo = parity && builtAt ? `read ${ago(builtAt - Date.parse(parity.fetchedAt))} ago ↗` : "read — ↗";

  // register
  const contact = lc?.contact ?? null;
  const contactAge = contact && builtAt ? builtAt - contact.timestamp * 1000 : null;
  const contactHead = contact && st ? st[keyOf(contact.chainId)].head : null;
  const active = contactAge !== null && contactAge < 600_000;
  const register = !lc ? (
    <span className="cursor-blink text-ink-3">SCANNING HISTORY FOR LAST $VIBES CONTACT</span>
  ) : !contact ? (
    <span className="text-ink-2">
      NO $VIBES CONTACT IN SCANNED RANGE · BASE #{lc.scanned.base.from ? group(lc.scanned.base.from) : "—"}–#{lc.scanned.base.to ? group(lc.scanned.base.to) : "—"} · RH #{lc.scanned.rh.from ? group(lc.scanned.rh.from) : "—"}–#
      {lc.scanned.rh.to ? group(lc.scanned.rh.to) : "—"}
    </span>
  ) : (
    <span className="text-ink-2">
      <span className={active ? "" : "text-ink"} style={active ? { color: CHAIN_COLOR[keyOf(contact.chainId)] } : undefined}>
        {active ? "ACTIVE · $VIBES CONTACT " : "QUIET "}
        <span ref={quietRef}>{contactAge !== null ? ago(contactAge) : "—"}</span>
        {active ? " AGO" : ""}
      </span>
      {" · LAST $VIBES CONTACT "}
      {CHAIN_LABEL[keyOf(contact.chainId)]} · {contact.label} ·{" "}
      <a href={explorerTx(contact.chainId, contact.tx)} target="_blank" rel="noopener noreferrer" className="text-ink hover:underline">
        #{group(contact.block)} ↗
      </a>
      {" · "}
      <span ref={watchedRef} className="text-ink">
        {contactHead !== null ? group(Math.max(0, contactHead - Number(contact.block))) : "—"}
      </span>{" "}
      {CHAIN_LABEL[keyOf(contact.chainId)]} BLOCKS SINCE
    </span>
  );

  const railCls = "hidden min-w-0 text-[9.5px] uppercase leading-[1.75] tracking-[0.04em] @min-[560px]:block";
  const p2Title = st ? `PERMIT2 · ${st.coverageSec >= 60 ? 60 : st.coverageSec} S` : "PERMIT2 · — S";

  return (
    <section
      ref={rootRef}
      className="panel @container mono min-w-0 overflow-hidden"
      data-sentinel-watch=""
      data-state={phase}
      data-head-base={st?.base.head ?? ""}
      data-head-rh={st?.rh.head ?? ""}
      data-ticks="0"
      style={{ ["--sw-flash" as string]: "rgba(145,217,130,0.12)" }}
    >
      <style>{CSS}</style>
      <header className="flex flex-nowrap items-center justify-between gap-x-3 border-b hairline px-4 py-2.5 max-[601px]:px-3">
        <SectionLabel n="LIVE" className="min-w-0 truncate">
          Sentinel watch · K-60
        </SectionLabel>
        <div className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-[11px] tnum">
          <span aria-live="off">{chip}</span>
          <span ref={clockRef} className="text-ink-2 @max-[520px]:hidden">
            {snapT !== null ? `${hms(snapT)} UTC` : "—"}
          </span>
          <button
            type="button"
            onClick={togglePause}
            aria-pressed={paused}
            className="rounded-[2px] border border-hair-strong px-1.5 py-0.5 text-[10px] text-ink-2 hover:border-phosphor/60 hover:text-phosphor max-[901px]:min-h-9 max-[901px]:px-3"
          >
            {paused ? "RESUME" : "PAUSE"}
          </button>
        </div>
      </header>

      {/* chain strips */}
      <div className="grid grid-cols-2 border-b hairline">
        {strip("base")}
        {strip("rh")}
      </div>

      {/* bay */}
      <div className="grid items-center gap-3 px-3 py-4 @min-[560px]:grid-cols-[104px_minmax(0,1fr)_104px] @min-[560px]:px-4">
        <div className={railCls}>
          <p className="text-ink-3">ARM = UTC SECOND</p>
          <p className="text-ink-3">FACE = LAST 60 S</p>
          <p style={{ color: COLOR.base }}>INNER = BASE</p>
          <p style={{ color: COLOR.rh }}>OUTER = RH</p>
          <p className="text-ink-3">1 BAR = 1 BLOCK</p>
          <p className="text-ink-3" title={`BASE LEN = √ gasUsed/limit · RH LEN = √ gasUsed ÷ ${rhShareLabel(rhCad)} (14M gas/s × ${rhCad.toFixed(0)} ms)`}>
            LEN = √ GAS USED
          </p>
          <p className="text-ink-3">
            <span style={{ color: COLOR.base }}>BASE</span> ÷ GAS LIMIT
          </p>
          <p className="text-ink-3">
            <span style={{ color: COLOR.rh }}>RH</span> ÷ {rhShareLabel(rhCad)} GAS
          </p>
          <p className="mt-2 text-ink-3">PERMIT2 LANE</p>
          <p className="text-ink-2">| GRANT</p>
          <p className="text-warn">| MAX GRANT</p>
          <p className="text-phosphor">┃ REVOKE</p>
        </div>

        <figure ref={figRef} role="img" aria-label={ariaInit} className="relative mx-auto aspect-square w-full max-w-[340px] cursor-crosshair select-none @min-[560px]:max-w-[360px]">
          <div ref={svgWrapRef} className="absolute inset-0">
            <FaceSvg data={face} className="h-full w-full" />
          </div>
          <canvas
            ref={canvasRef}
            data-sentinel-canvas=""
            aria-hidden="true"
            className="mono absolute inset-0 h-full w-full transition-opacity duration-300"
            style={{ opacity: live ? 1 : 0 }}
          />
          {/* centre readout */}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <p className="text-[10px] tracking-[0.12em] text-ink-2">THREAT</p>
            {scan ? (
              <>
                <Link
                  href={`/app?target=${VIBES_BASE}&chain=8453&tab=briefing`}
                  className="pointer-events-auto text-[30px] leading-none tnum hover:underline @min-[560px]:text-[42px]"
                  style={{ color: bandColor }}
                >
                  {scan.score}
                </Link>
                <p className="mt-0.5 text-[10px] @min-[560px]:mt-1" style={{ color: bandColor }}>
                  ● {scan.band}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[10px] text-ink-2">SCAN UNAVAILABLE</p>
            )}
          </div>
          {!snap && (
            <div className="pointer-events-none absolute inset-x-0 bottom-[18%] text-center text-[9.5px] text-crit">SIGNAL LOST AT SNAPSHOT · LIVE FEED RECONNECTING</div>
          )}
          <div ref={tipRef} hidden className="absolute z-10 max-w-[260px] rounded-[2px] border border-hair-strong bg-elevated px-2 py-1.5 text-[10.5px] leading-snug text-ink-2" role="tooltip">
            <span ref={tipTextRef} />{" "}
            <a ref={tipLinkRef} href="#" target="_blank" rel="noopener noreferrer" className="text-phosphor hover:underline">
              open ↗
            </a>
          </div>
          <figcaption ref={captionRef} className="sr-only">
            {ariaInit}
          </figcaption>
        </figure>

        <div className={railCls}>
          <p className="text-ink-3">
            <span ref={p2TitleRef}>{p2Title}</span>
          </p>
          <p style={{ color: COLOR.base }}>
            <span ref={p2BaseRef}>{!st ? "BASE —" : snapNoLogs.base ? "BASE — events unavailable" : `BASE ${st.p2.base} · ${st.p2.baseMax} MAX`}</span>
          </p>
          <p style={{ color: COLOR.rh }}>
            <span ref={p2RhRef}>{!st ? "RH —" : snapNoLogs.rh ? "RH — events unavailable" : `RH ${st.p2.rh} · ${st.p2.rhMax} MAX`}</span>
          </p>
          <p className="text-phosphor">
            <span ref={p2RevRef}>{st && !(snapNoLogs.base && snapNoLogs.rh) ? `REVOKES ${st.p2.revokes}` : "REVOKES —"}</span>
          </p>
          <p className="mt-2 text-ink-3">OFT 1:1 PARITY</p>
          <p className={parityTone}>{parityText}</p>
          <Link href="/app?tab=parity" className="block text-ink-3 hover:text-ink">
            <span ref={parityAgoRef}>{parityAgo}</span>
          </Link>
          {scan && (
            <>
              <p className="mt-2 text-ink-3">THREAT SCAN BASE</p>
              <a href={explorerBlock(8453, scan.block)} target="_blank" rel="noopener noreferrer" title={`$VIBES scan block on Base${scanAgoMin !== null ? ` · read at page render, ${scanAgoMin}m ago` : ""}`} className="block whitespace-nowrap text-ink-2 hover:text-ink">
                #{group(scan.block)} ↗
              </a>
            </>
          )}
          <p className="mt-2 text-ink-3">GENESIS ESCROW</p>
          {escrow?.openEndsAt ? (
            <p className="text-warn">
              CHALLENGE <Countdown to={escrow.openEndsAt} initialNow={nowSec} />
            </p>
          ) : (
            <p className="text-ink-2">{escrow ? "NO OPEN 72H WINDOW" : "—"}</p>
          )}
        </div>

        <div className="space-y-0.5 text-center text-[9.5px] uppercase tracking-[0.05em] text-ink-3 @min-[560px]:hidden">
          <p>
            ARM = UTC S · 1 BAR = 1 BLOCK · LEN = √ GAS USED (INNER BASE ÷ LIMIT · OUTER RH ÷ {rhShareLabel(rhCad)}, 14M GAS/S) · | MAX ┃ REVOKE
          </p>
          <p className="text-ink-2">
            <span ref={capRef}>
              {st
                ? `PERMIT2 ${st.coverageSec >= 60 ? 60 : st.coverageSec}S · ${snapNoLogs.base ? "BASE — events unavailable" : `BASE ${st.p2.base}/${st.p2.baseMax} MAX`} · ${snapNoLogs.rh ? "RH — events unavailable" : `RH ${st.p2.rh}/${st.p2.rhMax} MAX`} · OFT 1:1 ${parity?.status ?? "UNKNOWN"}`
                : "PERMIT2 —"}
            </span>
          </p>
          {scan && (
            <p>
              THREAT SCAN ·{" "}
              <a href={explorerBlock(8453, scan.block)} target="_blank" rel="noopener noreferrer" title="$VIBES scan block" className="text-ink-2 hover:text-ink">
                BASE #{group(scan.block)} ↗
              </a>
            </p>
          )}
          <p>
            GENESIS ESCROW ·{" "}
            {escrow?.openEndsAt ? (
              <span className="text-warn">
                CHALLENGE <Countdown to={escrow.openEndsAt} initialNow={nowSec} />
              </span>
            ) : escrow ? (
              "NO OPEN 72H WINDOW"
            ) : (
              "—"
            )}
          </p>
        </div>
      </div>

      {/* register */}
      <p
        key={flashKey ?? "reg"}
        className={cx("border-y hairline px-4 py-2 text-[10.5px] leading-relaxed [overflow-wrap:anywhere] max-[601px]:px-3", flashKey && "sw-flash")}
        style={contact ? ({ ["--sw-flash" as string]: keyOf(contact.chainId) === "base" ? "rgba(56,189,248,0.12)" : "rgba(200,255,0,0.12)" } as CSSProperties) : undefined}
      >
        {register}
      </p>

      {/* Morning Desk Brief (server-rendered plain text; Pillar 1 output for crawlers and no-JS) */}
      {brief && (brief.text || brief.topFinding) ? (
        <p className="border-b hairline px-4 py-2 text-[10.5px] leading-relaxed text-ink-2 [overflow-wrap:anywhere] max-[601px]:px-3">
          <span className="text-phosphor">MORNING DESK BRIEF</span>
          {" · "}
          {brief.text ?? brief.topFinding}{" "}
          <Link href={`/app?target=${VIBES_BASE}&chain=8453&tab=briefing`} className="whitespace-nowrap text-ink hover:text-phosphor hover:underline">
            → full briefing
          </Link>
        </p>
      ) : null}

      {/* tape */}
      <ol aria-live="off" aria-label="Replayed onchain events" className="h-[120px] overflow-hidden text-[11px] max-[601px]:text-[10.5px]">
        {tape.map((r, i) => (
          <TapeLine key={r.key} row={r} animate={i === 0 && r.key !== "snap-sum" && phase !== "snapshot"} />
        ))}
      </ol>

      {/* footer */}
      <p className="border-t hairline px-4 py-2 text-[9.5px] leading-relaxed text-ink-3 [overflow-wrap:anywhere] max-[601px]:px-3">
        <span className="hidden @min-[560px]:inline">src eth_feeHistory + eth_getLogs · Permit2 + $VIBES token/pool/OFT/escrow · </span>
        <span className="@min-[560px]:hidden">src feeHistory + getLogs · </span>
        <span ref={sweepRef}>
          {base?.ok || rh?.ok
            ? `sweep BASE ${!base?.ok ? "—" : !base.logsOk ? "— events unavailable" : `#${group(base.from ?? "0")}–#${group(base.logsTo ?? "0")}`} · RH ${!rh?.ok ? "—" : !rh.logsOk ? "— events unavailable" : `#${group(rh.from ?? "0")}–#${group(rh.logsTo ?? "0")}`} · RH bearings interpolated (${rh?.cadenceMs ? rh.cadenceMs.toFixed(0) : "—"} ms cadence)`
            : "sweep —"}
        </span>
      </p>
      <p ref={liveRegionRef} aria-live="polite" className="sr-only" />
    </section>
  );
}

function TapeLine({ row, animate }: { row: TapeRow; animate: boolean }) {
  const base = cx("grid h-6 items-center gap-x-2 border-b border-white/[0.04] px-4 max-[601px]:px-3", animate && "sw-in");
  if (row.type === "sys") {
    return (
      <li className={cx(base, "grid-cols-[minmax(0,auto)_minmax(0,1fr)]")} style={{ background: "rgba(145,217,130,0.04)" }}>
        <span className={row.crit ? "text-crit" : "text-phosphor"}>{row.tag}</span>
        <span className="truncate text-ink-2" title={row.text}>
          {row.text.startsWith(row.tag) ? row.text.slice(row.tag.length).replace(/^\s*·?\s*/, "") : row.text}
        </span>
      </li>
    );
  }
  if (row.type === "sum") {
    return (
      <li className={cx(base, "grid-cols-[minmax(0,1fr)_auto]")}>
        <span className="truncate text-ink-2">{row.text}</span>
        <a href={explorerBlock(row.chainId, row.from)} target="_blank" rel="noopener noreferrer" className="text-ink-3 hover:text-ink">
          ↗
        </a>
      </li>
    );
  }
  const ch = keyOf(row.chainId);
  const kind = kindLabel(row.kind, row.contact);
  const kindCls = row.contact ? "" : row.kind === "P2_MAX" ? "text-warn" : row.kind === "P2_REVOKE" ? "text-phosphor" : "text-ink-2";
  const kindStyle = row.contact ? { color: CHAIN_COLOR[ch], background: ch === "base" ? "rgba(56,189,248,0.12)" : "rgba(200,255,0,0.12)", padding: "0 3px" } : undefined;
  const txLink = (
    <a href={explorerTx(row.chainId, row.tx)} target="_blank" rel="noopener noreferrer" className="text-ink-3 hover:text-ink" aria-label="transaction on explorer">
      ↗
    </a>
  );
  return (
    <li className={cx("border-b border-white/[0.04] px-4 max-[601px]:px-3", animate && "sw-in")}>
      {/* narrow (< 520px container): two lines — "RH #108,331,725 MAX" / "→ spender · token ↗" */}
      <div className="grid h-9 grid-cols-[minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-2 leading-[1.15] @min-[520px]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <span style={{ color: CHAIN_COLOR[ch] }}>{CHAIN_LABEL[ch]}</span>
          <a href={explorerBlock(row.chainId, row.block)} target="_blank" rel="noopener noreferrer" className="text-ink hover:underline">
            #{group(row.block)}
          </a>
          <span className={cx("truncate", kindCls)} style={kindStyle}>
            {kind}
          </span>
        </span>
        <span className="row-span-2 flex justify-end">{txLink}</span>
        <span className="truncate text-ink-2" title={row.summary}>
          {row.detail}
        </span>
      </div>
      {/* wide: one line */}
      <div className="hidden h-6 grid-cols-[84px_40px_108px_84px_minmax(0,1fr)_56px] items-center gap-x-2 @min-[520px]:grid">
        <span className="text-ink-3">{tOf(row.chainId, row.t)}</span>
        <span style={{ color: CHAIN_COLOR[ch] }}>{CHAIN_LABEL[ch]}</span>
        <a href={explorerBlock(row.chainId, row.block)} target="_blank" rel="noopener noreferrer" className="truncate text-ink hover:underline">
          #{group(row.block)}
        </a>
        <span className={cx("truncate", kindCls)} style={kindStyle}>
          {kind}
        </span>
        <span className="truncate text-ink-2" title={row.summary}>
          {row.detail}
        </span>
        <span className="flex justify-end gap-1.5">
          {row.spender && !row.contact ? (
            <Link href={`/app?target=${row.spender}&chain=${row.chainId}&tab=briefing`} className="text-ink-3 hover:text-phosphor">
              X-RAY
            </Link>
          ) : null}
          {txLink}
        </span>
      </div>
    </li>
  );
}

