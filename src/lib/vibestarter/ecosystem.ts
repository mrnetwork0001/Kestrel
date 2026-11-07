import { type Address, getAddress } from "viem";
import { ERC20_ABI } from "@/lib/abis";
import { kvGetJson, kvSet, kvSetJson } from "@/lib/kv";
import { getPublicClientForChain } from "@/lib/rpc";
import { errMsg } from "@/lib/engine/chain-utils";
import { readEscrow } from "@/lib/engine/escrow";
import { bandFor, poolFindings, totalScore, xrayFindings } from "@/lib/engine/findings";
import { discoverWethPool, readPool } from "@/lib/engine/pools";
import { poolSides } from "@/lib/engine/sides";
import type { ChainId, EscrowNextEvent, Finding, EscrowReport, GithubVelocity, LpLockProof, RefundRadar, Severity, ThreatBand } from "@/lib/engine/types";
import { xrayContract } from "@/lib/engine/xray";
import { fmtDuration, fmtUnits } from "@/lib/format";
import { readLaunchUniverse, type LaunchUniverse, type VibestarterLaunch } from "./launches";

/**
 * Vibestarter Ecosystem Health Board — every Vibestarter launch on Base (8453) and Robinhood Chain (4663)
 * with live health: token X-Ray score (bytecode + controller posture + exit depth), on-chain Proof-of-Lock,
 * pool depth, escrow state + next countdown, Refund Radar, founder app HTTP health, founder GitHub velocity
 * and Origin Capsule status. Every value is read live (RPC / Vibestarter REST + MCP / GitHub / HTTP probe);
 * a read that fails or times out is reported as unavailable — never filled in.
 *
 * Caching: the assembled board is held on the shared KV with stale-while-revalidate semantics — fresh for
 * 120 s, then served stale (≤ 1 h) while one background rebuild runs, so pages never block on slow RPCs
 * once warm. Each row is additionally cached 120 s (`readEcosystemRow`). JSON-safe: uint256 as strings.
 */

export const ECOSYSTEM_FRESH_SEC = 120;
const MAX_STALE_SEC = 3_600;
const BOARD_KEY = "eco:board:v1";
const LOCK_KEY = "eco:board:rebuild-lock:v1";

const T_UNIVERSE = 15_000;
const T_ESCROW = 28_000;
const T_XRAY = 18_000;
const T_POOL = 15_000;

export type ReadStatus = "ok" | "none" | "unavailable";

export interface EcosystemSignal {
  tone: Severity;
  text: string;
}

export interface EcosystemTokenRisk {
  status: ReadStatus;
  score: number | null;
  band: ThreatBand | null;
  /** Points-bearing findings first (max 5). */
  findings: { id: string; severity: Severity; points: number; title: string }[];
  proxyKind: string | null;
  degraded: boolean;
  note: string;
}

export interface EcosystemPool {
  status: ReadStatus;
  address: string | null;
  venue: string | null;
  /** "lp-lock" = the pool recorded by the Vibestarter LP locker; "discovered" = deepest WETH pool found by factory probes. */
  source: "lp-lock" | "discovered" | null;
  quoteSymbol: string | null;
  quoteDecimals: number | null;
  /** quote.balanceOf(pool): real exit-side tokens held across all ranges (raw units). */
  quoteHeld: string | null;
  /** Active-range virtual depth for CL pools / reserve for v2 pools (raw units). */
  quoteReserve: string | null;
  reserveIsVirtual: boolean;
  block: string | null;
  note: string;
}

export interface EcosystemRow {
  key: string;
  chainId: ChainId;
  escrow: string;
  title: string | null;
  tagline: string | null;
  apiStatus: string | null;
  mcpStatus: string | null;
  sources: string[];
  vibestarterUrl: string | null;
  launchTx: string | null;
  token: { address: string; symbol: string | null; decimals: number | null } | null;
  /** On-chain escrow read (VibesTranchEscrow); null when the read failed — see `escrowError`. */
  escrowState: {
    state: number;
    stateLabel: string;
    generation: EscrowReport["generation"] | null;
    totalRaised: string;
    escrowBalance: string;
    tranchesPaid: number;
    tranchesTotal: number;
    nextEvent: EscrowNextEvent | null;
    lastWindow: EscrowReport["lastWindow"] | null;
    activeChallenge: { tranche: number; timestamp: number } | null;
    openWindow: { tranche: number; label: string; endsAt: number } | null;
    contributorCount: number | null;
    block: { number: string; timestamp: number };
  } | null;
  escrowError: string | null;
  tokenRisk: EcosystemTokenRisk;
  lpLock: LpLockProof | null;
  pool: EcosystemPool;
  refund: RefundRadar | null;
  appUrl: string | null;
  appHealth: EscrowReport["appHealth"];
  repoUrl: string | null;
  githubLogin: string | null;
  github: GithubVelocity | null;
  capsule: EscrowReport["capsule"];
  /** Lower = needs a backer's attention sooner (0 pending challenge … 6 closed / unknown). */
  attention: number;
  signals: EcosystemSignal[];
  fetchedAt: string;
}

export interface EcosystemTotals {
  launches: number;
  byChain: Record<string, number>;
  /** Sum of on-chain totalRaised per chain (wei; both chains settle in native ETH). */
  raisedWeiByChain: Record<string, string>;
  inEscrowWei: string;
  lpEthLockedWei: string;
  lockedPositions: number;
  appsUp: number;
  appsProbed: number;
  openWindows: number;
  pendingChallenges: number;
  refundsUnclaimedWei: string;
  escrowsRead: number;
}

export interface EcosystemBoard {
  rows: EcosystemRow[];
  totals: EcosystemTotals;
  universe: {
    ok: boolean;
    factories: LaunchUniverse["factories"];
    mcp: { ok: boolean; raises: number | null; error: string | null };
    restCount: number | null;
    error: string | null;
  };
  blocks: Record<string, string>;
  fetchedAt: string;
  buildMs: number;
  /** Cache metadata added at read time. */
  cache?: { ageSec: number; stale: boolean; refreshing: boolean };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/* ───────────────────────── token risk + pool ───────────────────────── */

async function readTokenXray(chainId: ChainId, token: Address) {
  try {
    return { x: await withTimeout(xrayContract(chainId, token), T_XRAY, "Token X-Ray"), error: null as string | null };
  } catch (e) {
    return { x: null, error: errMsg(e) };
  }
}

async function readEcoPool(chainId: ChainId, token: Address, lockPool: string | null): Promise<{ pool: EcosystemPool; snap: Awaited<ReturnType<typeof readPool>> }> {
  const empty = (status: ReadStatus, note: string): EcosystemPool => ({
    status, address: null, venue: null, source: null, quoteSymbol: null, quoteDecimals: null, quoteHeld: null, quoteReserve: null, reserveIsVirtual: false, block: null, note,
  });
  try {
    return await withTimeout(
      (async () => {
        const source: EcosystemPool["source"] = lockPool ? "lp-lock" : "discovered";
        const addr = lockPool ? getAddress(lockPool) : await discoverWethPool(chainId, token);
        if (!addr) return { pool: empty("none", "No WETH pool exists for this token on the scanned venues — no on-chain exit."), snap: null };
        const snap = await readPool(chainId, addr, { overnight: false });
        if (!snap) return { pool: { ...empty("unavailable", "Pool address did not answer as an AMM pool."), address: addr, source }, snap: null };
        const s = poolSides(snap);
        let held: bigint | null = null;
        if (s.quote) {
          held = await getPublicClientForChain(chainId)
            .readContract({ address: getAddress(s.quote.address), abi: ERC20_ABI, functionName: "balanceOf", args: [addr], blockNumber: BigInt(snap.block.number) })
            .catch(() => null);
        }
        const pool: EcosystemPool = {
          status: "ok",
          address: addr,
          venue: snap.venue,
          source,
          quoteSymbol: s.quote?.symbol ?? null,
          quoteDecimals: s.quote?.decimals ?? null,
          quoteHeld: held !== null ? held.toString() : null,
          quoteReserve: s.reserveQuote !== null ? s.reserveQuote.toString() : null,
          reserveIsVirtual: snap.reservesAreVirtual,
          block: snap.block.number,
          note: s.quote
            ? `${snap.venue} · ${s.quote.symbol} held by the pool${snap.reservesAreVirtual ? " (active-range virtual depth shown separately)" : ""}.`
            : `${snap.venue} · neither side is a known quote asset; depth not scored.`,
        };
        return { pool, snap };
      })(),
      T_POOL,
      "Pool read"
    );
  } catch (e) {
    return { pool: empty("unavailable", `Pool read failed: ${errMsg(e)}`), snap: null };
  }
}

function scoreToken(x: Awaited<ReturnType<typeof readTokenXray>>, snap: Awaited<ReturnType<typeof readPool>> | null, poolStatus: ReadStatus): EcosystemTokenRisk {
  if (!x.x) return { status: "unavailable", score: null, band: null, findings: [], proxyKind: null, degraded: true, note: x.error ? `X-Ray unavailable: ${x.error}` : "X-Ray unavailable." };
  const findings: Finding[] = [...xrayFindings(x.x), ...(snap ? poolFindings(snap) : [])];
  // same rule and weight as scanTarget() for a token without any WETH pool
  if (poolStatus === "none") findings.push({ id: "no-pool", severity: "warn", points: 12, title: "No WETH pool found", detail: "No on-chain WETH exit for this token on the scanned venues." });
  const score = totalScore(findings);
  const ranked = [...findings].sort((a, b) => b.points - a.points);
  return {
    status: "ok",
    score,
    band: bandFor(score),
    findings: ranked.slice(0, 5).map((f) => ({ id: f.id, severity: f.severity, points: f.points, title: f.title })),
    proxyKind: x.x.proxyKind,
    degraded: x.x.degraded,
    note: x.x.degraded
      ? `Some RPC reads failed (${x.x.degradedReasons.slice(0, 2).join("; ")}) — treat the score as incomplete.`
      : `Bytecode + EIP-1967 slots + controller posture${snap ? " + exit depth" : poolStatus === "none" ? " + no-pool penalty" : ""}, ${findings.length} findings.`,
  };
}

/* ───────────────────────── row assembly ───────────────────────── */

const FAILED = 4;
const FROZEN = 5;
const REFUNDING = 6;

function attentionOf(e: EcosystemRow["escrowState"]): number {
  if (!e) return 6;
  if (e.activeChallenge) return 0;
  if (e.openWindow) return 1;
  const k = e.nextEvent?.kind;
  if (k === "awaiting-request" || k === "awaiting-claim") return 2;
  if (k === "tranche-unlock" || k === "raise-deadline") return 3;
  if (e.state === REFUNDING || e.state === FROZEN) return 4;
  if (e.state === FAILED) return 5;
  return 6;
}

function buildSignals(r: Omit<EcosystemRow, "signals" | "attention">, now: number): EcosystemSignal[] {
  const out: EcosystemSignal[] = [];
  const e = r.escrowState;
  if (!e) out.push({ tone: "warn", text: `Escrow unreadable right now${r.escrowError ? ` (${r.escrowError.slice(0, 80)})` : ""}.` });
  if (e?.activeChallenge) out.push({ tone: "critical", text: `Challenge pending on Month ${e.activeChallenge.tranche} — tranche frozen until the admin rules.` });
  if (e?.openWindow) out.push({ tone: "warn", text: `${e.openWindow.label} challenge window open — closes in ${fmtDuration(e.openWindow.endsAt - now)}.` });
  const funded = e && (e.state === 3 || e.state === 7);
  if (r.lpLock?.status === "verified" && r.lpLock.lockedShareBps != null && r.lpLock.lockedShareBps < 9_500)
    out.push({ tone: "warn", text: `Only ${(r.lpLock.lockedShareBps / 100).toFixed(2)}% of pool LP is soulbound — the rest can be pulled.` });
  if (funded && r.lpLock && (r.lpLock.status === "not-locked" || r.lpLock.status === "rescued")) out.push({ tone: "critical", text: `Funded raise without a verified permanent LP lock (${r.lpLock.status}).` });
  if (r.tokenRisk.band === "CRITICAL") out.push({ tone: "critical", text: `Token X-Ray CRITICAL (${r.tokenRisk.score}/100).` });
  if (r.appHealth && !r.appHealth.ok) out.push({ tone: e && e.state === FAILED ? "info" : "warn", text: `Founder app ${r.appHealth.status ? `HTTP ${r.appHealth.status}` : `unreachable${r.appHealth.error ? ` (${r.appHealth.error.slice(0, 60)})` : ""}`}.` });
  if (r.github?.capsuleRepo?.status === "not-found") out.push({ tone: "warn", text: `Origin Capsule repo ${r.github.capsuleRepo.fullName} returns 404 (private or deleted).` });
  if (funded && r.github?.status === "ok" && r.github.pushes30d === 0) out.push({ tone: "warn", text: `No public GitHub pushes by @${r.github.login} in 30 days.` });
  if (r.capsule && !r.capsule.registered) out.push({ tone: "warn", text: "Token not registered in the chain's VibesRegistry (no on-chain Origin Capsule)." });
  if (r.refund && !r.refund.allClaimed && r.refund.unclaimedEthEstimate && BigInt(r.refund.unclaimedEthEstimate) > 0n)
    out.push({
      tone: "info",
      text: `${fmtUnits(r.refund.unclaimedEthEstimate, 18, 4)} ETH of ${r.refund.mode} refunds unclaimed${r.refund.sweepAfter ? ` — sweepable after ${new Date(r.refund.sweepAfter * 1000).toISOString().slice(0, 10)}` : ""}.`,
    });
  return out;
}

async function buildRow(l: VibestarterLaunch): Promise<EcosystemRow> {
  const chainId = l.chainId;
  const escrowAddr = getAddress(l.escrow);
  const listToken = l.tokenAddress ? getAddress(l.tokenAddress) : null;

  let escrowError: string | null = null;
  const reportP = withTimeout(readEscrow(chainId, escrowAddr), T_ESCROW, "Escrow read").catch((e: unknown) => {
    escrowError = errMsg(e);
    return null;
  });
  const earlyXrayP = listToken ? readTokenXray(chainId, listToken) : Promise.resolve(null);
  const [report, earlyXray] = await Promise.all([reportP, earlyXrayP]);

  const tokenAddr = report?.token ? getAddress(report.token) : listToken;
  const xray = tokenAddr ? (earlyXray && listToken && listToken.toLowerCase() === tokenAddr.toLowerCase() ? earlyXray : await readTokenXray(chainId, tokenAddr)) : null;
  const lockPool = report?.lpLock?.status === "verified" ? report.lpLock.pool : null;
  const poolRes = tokenAddr
    ? await readEcoPool(chainId, tokenAddr, lockPool)
    : { pool: { status: "unavailable" as const, address: null, venue: null, source: null, quoteSymbol: null, quoteDecimals: null, quoteHeld: null, quoteReserve: null, reserveIsVirtual: false, block: null, note: "Token address unknown." }, snap: null };
  const tokenRisk: EcosystemTokenRisk = xray
    ? scoreToken(xray, poolRes.snap, poolRes.pool.status)
    : { status: "unavailable", score: null, band: null, findings: [], proxyKind: null, degraded: true, note: "Token address unknown — X-Ray not run." };

  const open = report?.tranches.find((t) => t.status === "CHALLENGE_WINDOW") ?? null;
  const escrowState: EcosystemRow["escrowState"] = report
    ? {
        state: report.state,
        stateLabel: report.stateLabel,
        generation: report.generation ?? null,
        totalRaised: report.totalRaised,
        escrowBalance: report.escrowBalance,
        tranchesPaid: report.tranches.filter((t) => t.claimed).length,
        tranchesTotal: report.tranches.length,
        nextEvent: report.nextEvent ?? null,
        lastWindow: report.lastWindow ?? null,
        activeChallenge: report.activeChallenge ? { tranche: report.activeChallenge.tranche, timestamp: report.activeChallenge.timestamp } : null,
        openWindow: open ? { tranche: open.index, label: open.label, endsAt: open.windowEndsAt } : null,
        contributorCount: report.contributorCount,
        block: { number: report.block.number, timestamp: report.block.timestamp },
      }
    : null;

  const base: Omit<EcosystemRow, "signals" | "attention"> = {
    key: l.key,
    chainId,
    escrow: escrowAddr,
    title: report?.title ?? l.title,
    tagline: report?.tagline ?? null,
    apiStatus: report?.apiStatus ?? l.apiStatus,
    mcpStatus: l.mcpStatus,
    sources: [...l.sources],
    vibestarterUrl: report?.vibestarterUrl ?? l.vibestarterUrl,
    launchTx: report?.launchTx ?? l.launchTx,
    token: tokenAddr ? { address: tokenAddr, symbol: report?.tokenSymbol ?? l.tokenSymbol, decimals: report?.tokenDecimals ?? null } : null,
    escrowState,
    escrowError,
    tokenRisk,
    lpLock: report?.lpLock ?? null,
    pool: poolRes.pool,
    refund: report?.refund ?? null,
    appUrl: report?.appUrl ?? null,
    appHealth: report?.appHealth ?? null,
    repoUrl: report?.repoUrl ?? null,
    // founderGithub.login is "id:<n>" when the avatar id could not be resolved (rate-limited / missing): not a login.
    githubLogin: (report?.founderGithub?.login?.startsWith("id:") ? null : report?.founderGithub?.login) ?? report?.founderSignals?.githubUsername ?? null,
    github: report?.founderGithub ?? null,
    capsule: report?.capsule ?? null,
    fetchedAt: new Date().toISOString(),
  };
  const now = report?.oracleTime ?? Math.floor(Date.now() / 1000);
  return { ...base, attention: attentionOf(escrowState), signals: buildSignals(base, now) };
}

const rowInflight = new Map<string, Promise<EcosystemRow>>();

/**
 * One launch's live health row, cached 90 s on the shared KV (shorter than the board's 120 s so a board
 * rebuild never re-serves a row older than ~2 min). Rows whose escrow read failed are not cached.
 */
export function readEcosystemRow(launch: VibestarterLaunch): Promise<EcosystemRow> {
  const key = `eco:row:v1:${launch.key}`;
  const pending = rowInflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const hit = await kvGetJson<EcosystemRow>(key).catch(() => null);
    if (hit) return hit;
    const row = await buildRow(launch);
    if (row.escrowState && row.lpLock?.status !== "unavailable") await kvSetJson(key, row, { ex: 90 }).catch(() => undefined);
    return row;
  })().finally(() => rowInflight.delete(key));
  rowInflight.set(key, p);
  return p;
}

/** Board for a single launch key (`chainId:escrow`), e.g. for the API `?escrow=` filter. */
export async function readEcosystemRowByKey(chainId: ChainId, escrow: string): Promise<EcosystemRow | null> {
  const universe = await withTimeout(readLaunchUniverse(), T_UNIVERSE, "Launch universe");
  const l = universe.launches.find((x) => x.chainId === chainId && x.escrow.toLowerCase() === escrow.toLowerCase());
  return l ? readEcosystemRow(l) : null;
}

function sumTotals(rows: EcosystemRow[]): EcosystemTotals {
  const byChain: Record<string, number> = {};
  const raised: Record<string, bigint> = {};
  let inEscrow = 0n;
  let lpEth = 0n;
  let positions = 0;
  let appsUp = 0;
  let appsProbed = 0;
  let openWindows = 0;
  let pending = 0;
  let refunds = 0n;
  let read = 0;
  for (const r of rows) {
    byChain[r.chainId] = (byChain[r.chainId] ?? 0) + 1;
    if (r.escrowState) {
      read++;
      raised[r.chainId] = (raised[r.chainId] ?? 0n) + BigInt(r.escrowState.totalRaised);
      inEscrow += BigInt(r.escrowState.escrowBalance);
      if (r.escrowState.openWindow) openWindows++;
      if (r.escrowState.activeChallenge) pending++;
    }
    if (r.lpLock?.status === "verified" && r.lpLock.ethPaired) {
      lpEth += BigInt(r.lpLock.ethPaired);
      positions++;
    }
    if (r.appHealth) {
      appsProbed++;
      if (r.appHealth.ok) appsUp++;
    }
    if (r.refund?.unclaimedEthEstimate) refunds += BigInt(r.refund.unclaimedEthEstimate);
  }
  return {
    launches: rows.length,
    byChain,
    raisedWeiByChain: Object.fromEntries(Object.entries(raised).map(([k, v]) => [k, v.toString()])),
    inEscrowWei: inEscrow.toString(),
    lpEthLockedWei: lpEth.toString(),
    lockedPositions: positions,
    appsUp,
    appsProbed,
    openWindows,
    pendingChallenges: pending,
    refundsUnclaimedWei: refunds.toString(),
    escrowsRead: read,
  };
}

async function buildBoard(): Promise<EcosystemBoard> {
  const started = Date.now();
  let universe: LaunchUniverse | null = null;
  let universeError: string | null = null;
  try {
    universe = await withTimeout(readLaunchUniverse(), T_UNIVERSE, "Launch universe");
  } catch (e) {
    universeError = errMsg(e);
  }
  const launches = universe?.launches ?? [];
  const rows = await Promise.all(launches.map((l) => readEcosystemRow(l)));
  rows.sort((a, b) => a.attention - b.attention || (BigInt(b.escrowState?.totalRaised ?? "0") > BigInt(a.escrowState?.totalRaised ?? "0") ? 1 : -1));
  const blocks: Record<string, string> = {};
  for (const r of rows) {
    const n = r.escrowState?.block.number;
    if (n && (!blocks[r.chainId] || BigInt(n) > BigInt(blocks[r.chainId]))) blocks[r.chainId] = n;
  }
  return {
    rows,
    totals: sumTotals(rows),
    universe: {
      ok: Boolean(universe),
      factories: universe?.factories ?? [],
      mcp: { ok: universe?.mcp.ok ?? false, raises: universe?.mcp.raises ?? null, error: universe?.mcp.error ?? null },
      restCount: universe?.restCount ?? null,
      error: universeError,
    },
    blocks,
    fetchedAt: new Date().toISOString(),
    buildMs: Date.now() - started,
  };
}

/* ───────────────────────── stale-while-revalidate ───────────────────────── */

const g = globalThis as typeof globalThis & { __kestrelEcoRebuild?: Promise<EcosystemBoard> | null };

/** Rebuild the board now (deduplicated in-process) and store it on the shared KV. */
export function rebuildEcosystemBoard(): Promise<EcosystemBoard> {
  if (g.__kestrelEcoRebuild) return g.__kestrelEcoRebuild;
  const p = (async () => {
    const board = await buildBoard();
    // Only persist boards that actually read something, so a transient outage never overwrites good data.
    if (board.rows.length > 0 && board.totals.escrowsRead > 0) await kvSetJson(BOARD_KEY, board, { ex: MAX_STALE_SEC }).catch(() => undefined);
    return board;
  })().finally(() => {
    g.__kestrelEcoRebuild = null;
  });
  g.__kestrelEcoRebuild = p;
  return p;
}

/**
 * The board, fast: fresh KV copy (< 120 s) → returned; stale copy (≤ 1 h) → returned immediately and one
 * background rebuild is started (cross-instance lock); no copy → built inline. `onBackgroundRefresh`
 * receives the rebuild promise so serverless callers can keep it alive with `after()`.
 */
export async function getEcosystemBoard(opts: { onBackgroundRefresh?: (p: Promise<unknown>) => void } = {}): Promise<EcosystemBoard> {
  const hit = await kvGetJson<EcosystemBoard>(BOARD_KEY).catch(() => null);
  const ageSec = hit ? Math.max(0, Math.round((Date.now() - Date.parse(hit.fetchedAt)) / 1000)) : Infinity;
  if (hit && ageSec < ECOSYSTEM_FRESH_SEC) return { ...hit, cache: { ageSec, stale: false, refreshing: false } };
  if (hit && ageSec < MAX_STALE_SEC) {
    const gotLock = await kvSet(LOCK_KEY, "1", { ex: 90, nx: true }).catch(() => true);
    if (gotLock || g.__kestrelEcoRebuild) {
      const p = rebuildEcosystemBoard().catch(() => null);
      opts.onBackgroundRefresh?.(p);
    }
    return { ...hit, cache: { ageSec, stale: true, refreshing: true } };
  }
  const board = await rebuildEcosystemBoard();
  return { ...board, cache: { ageSec: 0, stale: false, refreshing: false } };
}
