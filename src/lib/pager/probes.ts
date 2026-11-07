import "server-only";
import { type Abi, type Address, getAddress, type Log } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { AERODROME_FACTORY_ABI, AERODROME_POOL_ABI, ERC20_ABI, OWNABLE_ABI, SAFE_MULTISIG_ABI, VIBES_ESCROW_ABI } from "@/lib/abis";
import { CL_POOL_ABI } from "@/lib/abis/pools-extra";
import { inspectRawBytecode, parseAddressFromSlot } from "@/lib/bytecode-signatures";
import { isRpcFailure } from "@/lib/engine/call-errors";
import { getLogsChunked, supportsTopicOnlyLogs } from "@/lib/engine/logs";
import { getPublicClientForChain } from "@/lib/rpc";
import type { ChainId } from "@/lib/engine/types";
import {
  ADMIN_TOPICS,
  LOG_ADDRESS_FANOUT,
  LOG_CAP,
  LOG_FILTER_FANOUT,
  MAX_RANGE,
  MULTICALL3,
  MULTICALL3_ABI,
  OFT_ADAPTER_ABI,
  PAUSABLE_ABI,
  PERMIT2,
  SLOTS,
  T,
  VIBES_ADMIN_SAFE,
  VIBES_BRIDGE,
} from "./constants";
import type { Hex, RuleType, Watch, WatchState } from "./types";

/**
 * Night-Shift Pager probe layer (spec §7). Every enabled watch declares its reads through
 * `planFor(watch, state)`; the tick merges and dedupes all plans and runs ONE pass per chain:
 * one multicall (16 KB chunks), one JSON-RPC batch of storage slots, a few address-filtered
 * eth_getLogs (chunked for Base's 200 ms blocks), plus nonce / allowance follow-ups only for
 * the wallets and approvals that actually changed. Robinhood Chain requests run sequentially
 * (bursts get HTTP 429). Nothing here fabricates a value: a failed read is `ok: false` / null.
 */

export interface CallSpec { chainId: ChainId; address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }
export interface SlotSpec { chainId: ChainId; address: Address; slot: Hex }
export interface WalletSpec { chainId: ChainId; address: Address; prevBalance: string | null; prevNonce: number | null }
export interface ReadPlan {
  calls: CallSpec[];
  slots: SlotSpec[];
  approvalOwners: { chainId: ChainId; owner: Address; tokens: Address[] }[]; // Base: tokens → address filter
  transferTokens: { chainId: ChainId; token: Address }[];
  adminAddrs: { chainId: ChainId; address: Address }[];
  burnPools: { chainId: ChainId; pool: Address }[];
  wallets: WalletSpec[];
}

export const emptyPlan = (): ReadPlan => ({ calls: [], slots: [], approvalOwners: [], transferTokens: [], adminAddrs: [], burnPools: [], wallets: [] });

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export const callKey = (c: Pick<CallSpec, "chainId" | "address" | "functionName" | "args">) =>
  `${c.chainId}:${c.address.toLowerCase()}:${c.functionName}:${JSON.stringify(c.args ?? [], big)}`;
const slotKey = (address: string, slot: string) => `${address.toLowerCase()}:${slot.toLowerCase()}`;
const allowanceKey = (token: string, owner: string, spender: string) => `${token}:${owner}:${spender}`.toLowerCase();

export interface CallResult { ok: boolean; result?: unknown }
export interface TokenInfo { symbol: string; decimals: number }

export interface ChainSnapshot {
  chainId: ChainId;
  block: { number: bigint; timestamp: number };
  range: { from: bigint; to: bigint; gapBlocks: bigint }; // logs window (cursor, latest]
  call: (c: { address: string; functionName: string; args?: readonly unknown[] }) => CallResult;
  /** Raw 32-byte slot value, or null when the slot was not read / the read failed. */
  slot: (address: string, slot: string) => Hex | null;
  /** Nonce at `block` for wallets whose balance changed (or had no baseline); null = not read. */
  nonce: (address: string) => number | null;
  /** Live ERC-20 allowance at `block` for approval logs seen this tick (verifies the event is real). */
  allowance: (token: string, owner: string, spender: string) => bigint | null;
  tokenInfo: (token: string) => TokenInfo | null;
  logs: { approvals: Log[]; transfers: Log[]; admin: Log[]; burns: Log[] };
  /** False when the log queries failed: log-driven rules must not claim "nothing happened". */
  logsOk: boolean;
  /**
   * Last block whose logs were fully processed: `range.to` when logsOk, else `range.from − 1` (the previous
   * cursor). The tick should persist THIS as the chain cursor so a failed log window is retried next tick
   * (dedupe keys prevent double alerts).
   */
  logsCursor: bigint;
  errors: string[];
}

/** Plain data behind a snapshot (also used by fixtures / dry runs to build synthetic snapshots). */
export interface SnapshotData {
  chainId: ChainId;
  block: { number: bigint; timestamp: number };
  range?: { from: bigint; to: bigint; gapBlocks: bigint };
  calls?: Record<string /* callKey */, CallResult>;
  slots?: Record<string /* address:slot */, Hex>;
  nonces?: Record<string, number>;
  allowances?: Record<string /* token:owner:spender */, string>;
  tokens?: Record<string, TokenInfo>;
  logs?: Partial<ChainSnapshot["logs"]>;
  logsOk?: boolean;
  errors?: string[];
}

export function makeSnapshot(d: SnapshotData): ChainSnapshot {
  const calls = d.calls ?? {};
  const slots: Record<string, Hex> = {};
  for (const [k, v] of Object.entries(d.slots ?? {})) slots[k.toLowerCase()] = v;
  const nonces: Record<string, number> = {};
  for (const [k, v] of Object.entries(d.nonces ?? {})) nonces[k.toLowerCase()] = v;
  const allowances: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.allowances ?? {})) allowances[k.toLowerCase()] = v;
  const tokens: Record<string, TokenInfo> = {};
  for (const [k, v] of Object.entries(d.tokens ?? {})) tokens[k.toLowerCase()] = v;
  return {
    chainId: d.chainId,
    block: d.block,
    range: d.range ?? { from: d.block.number, to: d.block.number, gapBlocks: 0n },
    call: (c) => calls[callKey({ chainId: d.chainId, ...c, address: c.address as Address })] ?? { ok: false },
    slot: (a, s) => slots[slotKey(a, s)] ?? null,
    nonce: (a) => nonces[a.toLowerCase()] ?? null,
    allowance: (t, o, s) => {
      const v = allowances[allowanceKey(t, o, s)];
      return v === undefined ? null : BigInt(v);
    },
    tokenInfo: (t) => tokens[t.toLowerCase()] ?? null,
    logs: { approvals: [], transfers: [], admin: [], burns: [], ...(d.logs ?? {}) },
    logsOk: d.logsOk ?? true,
    logsCursor: (d.logsOk ?? true) ? (d.range?.to ?? d.block.number) : (d.range?.from ?? d.block.number) - 1n,
    errors: d.errors ?? [],
  };
}

/* ------------------------------------------------------------------------------------------------ */
/* Plans                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

const on = (w: Watch, t: RuleType) => w.rules.some((r) => r.type === t && r.enabled);

/** Calls feeding the $VIBES parity + spread globals (deduped with pool watches of the same pools). */
export const VIBES_GLOBAL_CALLS: CallSpec[] = [
  { chainId: 8453, address: CONTRACTS.base.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.base.vibesBridgeAdapter] },
  { chainId: 8453, address: CONTRACTS.base.vibesAerodromePool, abi: AERODROME_POOL_ABI, functionName: "getReserves" },
  { chainId: 8453, address: CONTRACTS.base.aerodromeFactory, abi: AERODROME_FACTORY_ABI, functionName: "getFee", args: [CONTRACTS.base.vibesAerodromePool, false] },
  { chainId: 4663, address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "totalSupply" },
  { chainId: 4663, address: CONTRACTS.robinhood.vibesToken, abi: ERC20_ABI, functionName: "balanceOf", args: [CONTRACTS.robinhood.vibesReserveAdapter] },
  { chainId: 4663, address: CONTRACTS.robinhood.vibesUniswapV3Pool, abi: CL_POOL_ABI, functionName: "slot0" },
  { chainId: 4663, address: CONTRACTS.robinhood.vibesUniswapV3Pool, abi: CL_POOL_ABI, functionName: "liquidity" },
  { chainId: 4663, address: CONTRACTS.robinhood.vibesUniswapV3Pool, abi: CL_POOL_ABI, functionName: "fee" },
];

export const NUM_TRANCHES = 7;
export const ESCROW_CORE_FNS = ["getCampaign", "getActiveChallenge", "getCurrentTime", "CHALLENGE_WINDOW"] as const;
export const ESCROW_TRANCHE_FNS = ["trancheRequestedAt", "trancheClaimed", "trancheChallenged", "getTrancheUnlockTime", "getTrancheAmount"] as const;

/** Reads one watch needs this tick. */
export function planFor(w: Watch, st: WatchState | undefined): ReadPlan {
  const p = emptyPlan();
  const c = w.chainId;
  const target = w.target as Address;
  const call = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[], chainId: ChainId = c) =>
    p.calls.push({ chainId, address, abi, functionName, args });

  // Pools (pool watch, or a token watch's discovered WETH pool)
  if (w.meta.pool && (on(w, "lp_liquidity_drop") || on(w, "price_move"))) {
    const pool = w.meta.pool.address as Address;
    if (w.meta.pool.kind === "aerodrome-v2") call(pool, AERODROME_POOL_ABI as Abi, "getReserves");
    else {
      call(pool, CL_POOL_ABI as Abi, "slot0");
      call(pool, CL_POOL_ABI as Abi, "liquidity");
    }
    if (on(w, "lp_liquidity_drop")) p.burnPools.push({ chainId: c, pool });
  }

  // Token supply / whale transfers
  if (w.meta.token && (on(w, "supply_change") || on(w, "whale_transfer"))) call(w.meta.token.address as Address, ERC20_ABI as Abi, "totalSupply");
  if (w.meta.token && on(w, "whale_transfer")) p.transferTokens.push({ chainId: c, token: w.meta.token.address as Address });

  // Proxy slots, owner, Safe, paused
  const wantsUpgrade = on(w, "proxy_upgrade");
  const wantsAdmin = on(w, "admin_change");
  if (w.meta.proxy && (wantsUpgrade || wantsAdmin)) {
    for (const s of w.meta.proxy.slots) {
      const isAdminSlot = s === "eip1967Admin" || s === "ozAdmin";
      if ((isAdminSlot && wantsAdmin) || (!isAdminSlot && wantsUpgrade) || (!isAdminSlot && wantsAdmin)) p.slots.push({ chainId: c, address: target, slot: SLOTS[s] });
    }
    if (wantsAdmin && w.meta.proxy.hasOwnerFn) call(target, OWNABLE_ABI as Abi, "owner");
    if (wantsAdmin) call(target, PAUSABLE_ABI as Abi, "paused");
    if (wantsAdmin && w.meta.proxy.safe) {
      call(w.meta.proxy.safe as Address, SAFE_MULTISIG_ABI as Abi, "getThreshold");
      call(w.meta.proxy.safe as Address, SAFE_MULTISIG_ABI as Abi, "getOwners");
    }
    p.adminAddrs.push({ chainId: c, address: target });
  }

  // $VIBES bridge governance (both adapters, on their own chains)
  if (w.meta.vibes && w.meta.bridge?.length && (on(w, "bridge_peer_change") || wantsAdmin)) {
    for (const lane of w.meta.bridge) {
      const a = lane.adapter as Address;
      if (on(w, "bridge_peer_change")) {
        call(a, OFT_ADAPTER_ABI as Abi, "peers", [lane.eid], lane.chainId);
        call(a, OFT_ADAPTER_ABI as Abi, "creditBudget", [lane.eid], lane.chainId);
        call(a, OFT_ADAPTER_ABI as Abi, "rateLimits", [lane.eid], lane.chainId);
        call(a, OFT_ADAPTER_ABI as Abi, "paused", undefined, lane.chainId);
        call(a, OFT_ADAPTER_ABI as Abi, "pauser", undefined, lane.chainId);
      }
      if (wantsAdmin) {
        call(a, OFT_ADAPTER_ABI as Abi, "owner", undefined, lane.chainId);
        call(VIBES_ADMIN_SAFE as Address, SAFE_MULTISIG_ABI as Abi, "getThreshold", undefined, lane.chainId);
        call(VIBES_ADMIN_SAFE as Address, SAFE_MULTISIG_ABI as Abi, "getOwners", undefined, lane.chainId);
      }
      p.adminAddrs.push({ chainId: lane.chainId, address: a });
    }
  }

  // Parity / spread globals
  if (w.meta.vibes && (on(w, "parity_drift") || on(w, "spread_bps"))) p.calls.push(...VIBES_GLOBAL_CALLS);

  // Escrow (uint8 tranche indexes on the deployed VibesTranchEscrow)
  if (w.kind === "escrow" && w.rules.some((r) => r.enabled && r.type.startsWith("escrow_"))) {
    for (const fn of ESCROW_CORE_FNS) call(target, VIBES_ESCROW_ABI as Abi, fn);
    for (let i = 0; i < NUM_TRANCHES; i++) for (const fn of ESCROW_TRANCHE_FNS) call(target, VIBES_ESCROW_ABI as Abi, fn, [i]);
  }

  // Wallets
  if (w.kind === "wallet") {
    if (on(w, "wallet_activity")) {
      call(MULTICALL3, MULTICALL3_ABI as Abi, "getEthBalance", [target]);
      p.wallets.push({ chainId: c, address: target, prevBalance: st?.wallet?.balance ?? null, prevNonce: st?.wallet?.nonce ?? null });
    }
    if (on(w, "wallet_new_approval")) p.approvalOwners.push({ chainId: c, owner: target, tokens: (w.meta.approvalTokens ?? []) as Address[] });
  }
  return p;
}

/** Merge the plans of every enabled watch (dedupe happens per chain inside probeChain). */
export function buildPlan(watches: Watch[], states: Record<string, WatchState | undefined>): ReadPlan {
  const out = emptyPlan();
  for (const w of watches) {
    if (!w.enabled) continue;
    const p = planFor(w, states[w.id]);
    out.calls.push(...p.calls);
    out.slots.push(...p.slots);
    out.approvalOwners.push(...p.approvalOwners);
    out.transferTokens.push(...p.transferTokens);
    out.adminAddrs.push(...p.adminAddrs);
    out.burnPools.push(...p.burnPools);
    out.wallets.push(...p.wallets);
  }
  return out;
}

/** Chains a plan touches (a $VIBES watch on Base also needs Robinhood reads). */
export function planChains(plan: ReadPlan): ChainId[] {
  const s = new Set<ChainId>();
  for (const x of [...plan.calls, ...plan.slots, ...plan.approvalOwners, ...plan.transferTokens, ...plan.adminAddrs, ...plan.burnPools, ...plan.wallets]) s.add(x.chainId);
  return [...s].sort((a, b) => b - a);
}

/* ------------------------------------------------------------------------------------------------ */
/* Probe                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of xs) if (!m.has(key(x))) m.set(key(x), x);
  return [...m.values()];
}
const uniqAddrs = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))] as Address[];
const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const pad32 = (a: string): Hex => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => {
  const x = e as { shortMessage?: string; details?: string; message?: string };
  return `${x?.shortMessage ?? ""} ${x?.details ?? ""} ${x?.message ?? String(e)}`.replace(/\s+/g, " ").trim().slice(0, 240);
};

/** Retry on HTTP 429 / rate-limit errors (Robinhood throttles bursts; F6): 300 ms, then 1 s. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [300, 1_000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const t = errText(e).toLowerCase();
      if (i >= delays.length || !(t.includes("429") || t.includes("rate limit") || t.includes("too many") || t.includes("request limit"))) throw e;
      await sleep(delays[i]);
    }
  }
}

type LogFilter = { address?: Address[]; topics: (Hex | Hex[] | null)[] };

/**
 * Shared chunked eth_getLogs (src/lib/engine/logs.ts: provider caps for Base 200 ms blocks / publicnode 50k,
 * RH topic-only 30k, bisection on result caps, 429 retries). A partially covered window throws so the
 * snapshot reports logsOk=false (never "nothing happened" when we did not look).
 */
/** Max bisection depth for a window whose logs exceed LOG_CAP (2^3 = 8 sub-windows of ≤ LOG_CAP each). */
const LOG_SPLIT_DEPTH = 3;

async function chunkedLogs(chainId: ChainId, f: LogFilter, from: bigint, to: bigint, notes: string[], deadline: number, depth = 0): Promise<Log[]> {
  if (Date.now() > deadline) throw new Error("log window split budget exhausted (window too busy this tick)");
  const res = await getLogsChunked(
    chainId,
    { address: f.address, topics: f.topics, fromBlock: from, toBlock: to },
    { maxLogs: LOG_CAP, timeBudgetMs: Math.max(2_000, Math.min(8_000, deadline - Date.now())), concurrency: chainId === 4663 ? 1 : 2, noCache: true }
  );
  if (res.unsupported) throw new Error(res.unsupported);
  if (!res.complete && !res.truncated) throw new Error(res.note || `logs incomplete (${res.failedRanges[0]?.error ?? "partial coverage"})`);
  if (!res.truncated) return res.logs;
  // Truncated: keeping only the newest LOG_CAP would silently skip older logs while the cursor advances past them.
  // 1) A grouped filter is split per address, so a busy token never hides a quiet token's older logs.
  if (f.address && f.address.length > 1) {
    const out: Log[] = [];
    for (const a of f.address) out.push(...(await chunkedLogs(chainId, { ...f, address: [a] }, from, to, notes, deadline, depth)));
    return out;
  }
  // 2) Bisect the window until every sub-window is complete; past the depth cap the window is reported failed
  //    (logsOk=false → the cursor holds) instead of half-read.
  if (depth >= LOG_SPLIT_DEPTH || to <= from) throw new Error(`more than ${LOG_CAP} logs in a ${to - from + 1n}-block sub-window; window not fully read`);
  const mid = from + (to - from) / 2n;
  const older = await chunkedLogs(chainId, f, from, mid, notes, deadline, depth + 1);
  const newer = await chunkedLogs(chainId, f, mid + 1n, to, notes, deadline, depth + 1);
  if (depth === 0) notes.push(`busy log window split into sub-windows (> ${LOG_CAP} logs)`);
  return [...older, ...newer];
}

async function fetchLogs(chainId: ChainId, plan: ReadPlan, from: bigint, to: bigint, notes: string[]): Promise<ChainSnapshot["logs"]> {
  // Topic-only (all tokens + NFTs) where the provider allows it: Robinhood always; Base only with BASE_LOGS_RPC_URL.
  const topicOnly = supportsTopicOnlyLogs(chainId);
  const sequential = chainId === 4663;
  const deadline = Date.now() + 18_000; // whole log pass, incl. splitting busy windows (probe timeout is 25 s)
  const jobs: (() => Promise<{ k: keyof ChainSnapshot["logs"]; logs: Log[] }>)[] = [];

  // Approvals: one query per ≤100 owners (Base: also ≤100 token addresses per query)
  const owners = plan.approvalOwners.filter((o) => o.chainId === chainId);
  if (owners.length) {
    const ownerChunks = chunk(uniqAddrs(owners.map((o) => o.owner)).map(pad32), LOG_FILTER_FANOUT);
    if (topicOnly) {
      for (const oc of ownerChunks) {
        jobs.push(async () => ({ k: "approvals", logs: await chunkedLogs(chainId, { topics: [[T.ERC20_APPROVAL, T.APPROVAL_FOR_ALL, T.PERMIT2_APPROVAL, T.PERMIT2_PERMIT], oc] }, from, to, notes, deadline) }));
      }
    } else {
      const addrs = uniqAddrs([PERMIT2, ...owners.flatMap((o) => o.tokens)]);
      for (const ac of chunk(addrs, LOG_ADDRESS_FANOUT[chainId])) {
        for (const oc of ownerChunks) {
          jobs.push(async () => ({ k: "approvals", logs: await chunkedLogs(chainId, { address: ac, topics: [[T.ERC20_APPROVAL, T.APPROVAL_FOR_ALL, T.PERMIT2_APPROVAL, T.PERMIT2_PERMIT], oc] }, from, to, notes, deadline) }));
        }
      }
    }
  }
  const tokens = uniqAddrs(plan.transferTokens.filter((t) => t.chainId === chainId).map((t) => t.token));
  for (const tc of chunk(tokens, LOG_ADDRESS_FANOUT[chainId])) jobs.push(async () => ({ k: "transfers", logs: await chunkedLogs(chainId, { address: tc, topics: [T.TRANSFER] }, from, to, notes, deadline) }));
  const admins = uniqAddrs(plan.adminAddrs.filter((a) => a.chainId === chainId).map((a) => a.address));
  for (const ac of chunk(admins, LOG_ADDRESS_FANOUT[chainId])) jobs.push(async () => ({ k: "admin", logs: await chunkedLogs(chainId, { address: ac, topics: [ADMIN_TOPICS] }, from, to, notes, deadline) }));
  const pools = uniqAddrs(plan.burnPools.filter((p) => p.chainId === chainId).map((p) => p.pool));
  for (const pc of chunk(pools, LOG_ADDRESS_FANOUT[chainId])) jobs.push(async () => ({ k: "burns", logs: await chunkedLogs(chainId, { address: pc, topics: [[T.AERO_BURN, T.V3_BURN]] }, from, to, notes, deadline) }));

  const res: ChainSnapshot["logs"] = { approvals: [], transfers: [], admin: [], burns: [] };
  const results: { k: keyof ChainSnapshot["logs"]; logs: Log[] }[] = [];
  if (sequential) for (const j of jobs) results.push(await j());
  else results.push(...(await Promise.all(jobs.map((j) => j()))));
  for (const r of results) res[r.k].push(...r.logs);
  return res;
}

/** The chain's state could not be read at all: the probe fails (the tick reports the chain not-ok). */
class ProbeReadError extends Error {}

const tokenInfoCache = new Map<string, { info: TokenInfo; at: number }>();
const TOKEN_TTL_MS = 6 * 3_600_000;

export interface ProbeOptions {
  /** Override the per-tick log window cap (blocks). */
  maxRange?: bigint;
  /** Skip log queries entirely (e.g. arm-time baselines). */
  skipLogs?: boolean;
}

/**
 * One read pass for one chain. `cursor` = last fully processed block (null on the first run: only
 * the newest block is scanned). If the scheduler was down longer than MAX_RANGE, the newest window
 * is scanned and `gapBlocks` records the skipped span; state-based rules still catch net changes.
 */
export async function probeChain(chainId: ChainId, plan: ReadPlan, cursor: bigint | null, opts: ProbeOptions = {}): Promise<ChainSnapshot> {
  const client = getPublicClientForChain(chainId);
  const latest = await withRetry(() => client.getBlock({ blockTag: "latest" })); // not getBlockNumber (cached ~4 s)
  const to = latest.number;
  const maxRange = opts.maxRange ?? MAX_RANGE[chainId];
  let from = cursor === null ? to : cursor + 1n;
  let gapBlocks = 0n;
  if (from > to) from = to + 1n; // nothing new (another tick already processed this block)
  if (to - from + 1n > maxRange) {
    gapBlocks = to - from + 1n - maxRange;
    from = to - maxRange + 1n;
  }

  const calls = dedupe(plan.calls.filter((c) => c.chainId === chainId), callKey);
  const slots = dedupe(plan.slots.filter((s) => s.chainId === chainId), (s) => slotKey(s.address, s.slot));
  const wallets = dedupe(plan.wallets.filter((w) => w.chainId === chainId), (w) => w.address.toLowerCase());
  const errors: string[] = [];
  const data: SnapshotData = {
    chainId,
    block: { number: to, timestamp: Number(latest.timestamp) },
    range: { from, to, gapBlocks },
    calls: {},
    slots: {},
    nonces: {},
    allowances: {},
    tokens: {},
    logsOk: true,
    errors,
  };

  const runMulticall = async () => {
    if (!calls.length) return;
    try {
      const read = (cs: typeof calls) =>
        withRetry(() =>
          client.multicall({ allowFailure: true, blockNumber: to, batchSize: 16_384, contracts: cs.map(({ address, abi, functionName, args }) => ({ address, abi, functionName, args })) as never })
        ) as Promise<{ status: "success" | "failure"; result?: unknown; error?: unknown }[]>;
      const res = await read(calls);
      // allowFailure turns a 429/timeout on an aggregate3 call into per-call failures (no throw, no withRetry):
      // re-read the RPC-failed calls once, then report what is still missing as a hard multicall error.
      const failedIdx = res.flatMap((r, i) => (isRpcFailure(r) ? [i] : []));
      if (failedIdx.length) {
        const again = await read(failedIdx.map((i) => calls[i])).catch(() => null);
        if (again) failedIdx.forEach((i, k) => (res[i] = again[k] ?? res[i]));
      }
      res.forEach((r, i) => {
        data.calls![callKey(calls[i])] = r.status === "success" ? { ok: true, result: r.result } : { ok: false };
      });
      const stillFailed = res.filter((r) => isRpcFailure(r)).length;
      if (stillFailed === res.length) throw new Error(`all ${res.length} state reads failed (RPC error)`);
      if (stillFailed) errors.push(`multicall: ${stillFailed}/${res.length} reads failed (RPC)`);
    } catch (e) {
      errors.push(`multicall: ${errText(e).slice(0, 160)}`);
      throw new ProbeReadError(`multicall: ${errText(e).slice(0, 160)}`);
    }
  };
  const runSlots = async () => {
    if (!slots.length) return;
    // Base: one JSON-RPC batch (http batch 50); RH: ≤ 20 per batch, sequential.
    for (const group of chunk(slots, chainId === 4663 ? 20 : 50)) {
      const vals = await Promise.all(
        group.map((s) => withRetry(() => client.getStorageAt({ address: s.address, slot: s.slot, blockNumber: to })).catch(() => undefined))
      );
      vals.forEach((v, i) => {
        if (v !== undefined) data.slots![slotKey(group[i].address, group[i].slot)] = (v ?? "0x0") as Hex;
      });
      if (vals.some((v) => v === undefined)) errors.push("storage: some slot reads failed");
    }
  };
  const runLogs = async () => {
    if (opts.skipLogs || from > to) return;
    try {
      data.logs = await fetchLogs(chainId, plan, from, to, errors);
    } catch (e) {
      data.logsOk = false;
      errors.push(`logs: ${errText(e).slice(0, 160)}`);
    }
  };

  if (chainId === 4663) {
    await runMulticall();
    await runSlots();
    await runLogs();
  } else {
    await Promise.all([runMulticall(), runSlots(), runLogs()]);
  }

  // Follow-ups (only for things that changed): nonces, approval allowances, token metadata.
  const snapNoFollow = makeSnapshot(data);
  const nonceTargets = wallets.filter((w) => {
    const r = snapNoFollow.call({ address: MULTICALL3, functionName: "getEthBalance", args: [w.address] });
    if (!r.ok) return w.prevNonce === null;
    return w.prevNonce === null || w.prevBalance === null || String(r.result) !== w.prevBalance;
  });
  const approvalChecks: { token: Address; owner: Address; spender: Address }[] = [];
  const metaTokens = new Set<string>();
  for (const l of data.logs?.approvals ?? []) {
    if (l.topics[0] === T.ERC20_APPROVAL && l.topics.length === 3 && l.topics[1] && l.topics[2]) {
      approvalChecks.push({ token: l.address, owner: `0x${l.topics[1].slice(26)}`, spender: `0x${l.topics[2].slice(26)}` });
      metaTokens.add(l.address.toLowerCase());
    } else if ((l.topics[0] === T.PERMIT2_APPROVAL || l.topics[0] === T.PERMIT2_PERMIT) && l.topics[2]) {
      metaTokens.add(`0x${l.topics[2].slice(26)}`);
    } else {
      metaTokens.add(l.address.toLowerCase());
    }
  }
  for (const l of data.logs?.transfers ?? []) metaTokens.add(l.address.toLowerCase());
  const now = Date.now();
  const needMeta = [...metaTokens].filter((t) => {
    const hit = tokenInfoCache.get(`${chainId}:${t}`);
    if (hit && now - hit.at < TOKEN_TTL_MS) {
      data.tokens![t] = hit.info;
      return false;
    }
    return true;
  });

  const follow: ({ kind: "allowance"; i: number } | { kind: "symbol" | "decimals"; t: string })[] = [];
  const followCalls: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[] = [];
  const checks = dedupe(approvalChecks, (c) => allowanceKey(c.token, c.owner, c.spender)).slice(0, 200);
  checks.forEach((c, i) => {
    follow.push({ kind: "allowance", i });
    followCalls.push({ address: getAddress(c.token), abi: ERC20_ABI as Abi, functionName: "allowance", args: [getAddress(c.owner), getAddress(c.spender)] });
  });
  for (const t of needMeta.slice(0, 100)) {
    follow.push({ kind: "symbol", t });
    followCalls.push({ address: getAddress(t), abi: ERC20_ABI as Abi, functionName: "symbol" });
    follow.push({ kind: "decimals", t });
    followCalls.push({ address: getAddress(t), abi: ERC20_ABI as Abi, functionName: "decimals" });
  }
  if (followCalls.length) {
    try {
      const res = (await withRetry(() => client.multicall({ allowFailure: true, blockNumber: to, batchSize: 16_384, contracts: followCalls as never }))) as { status: string; result?: unknown }[];
      const syms: Record<string, string> = {};
      const decs: Record<string, number> = {};
      const fuFailed = res.filter((r) => isRpcFailure(r as { status: "success" | "failure"; error?: unknown })).length;
      if (fuFailed) errors.push(`follow-up multicall: ${fuFailed}/${res.length} reads failed (RPC)`);
      res.forEach((r, i) => {
        const f = follow[i];
        if (r.status !== "success") return;
        if (f.kind === "allowance") {
          const c = checks[f.i];
          data.allowances![allowanceKey(c.token, c.owner, c.spender)] = String(r.result);
        } else if (f.kind === "symbol") syms[f.t] = String(r.result).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24);
        else decs[f.t] = Number(r.result);
      });
      for (const t of needMeta) {
        if (decs[t] === undefined || !Number.isInteger(decs[t]) || decs[t] > 77) continue;
        const info = { symbol: syms[t] || "token", decimals: decs[t] };
        data.tokens![t] = info;
        tokenInfoCache.set(`${chainId}:${t}`, { info, at: now });
      }
    } catch (e) {
      errors.push(`follow-up multicall: ${errText(e).slice(0, 120)}`);
    }
  }
  if (nonceTargets.length) {
    for (const group of chunk(nonceTargets, chainId === 4663 ? 20 : 50)) {
      const vals = await Promise.all(group.map((w) => withRetry(() => client.getTransactionCount({ address: w.address, blockNumber: to })).catch(() => null)));
      vals.forEach((v, i) => {
        if (v !== null) data.nonces![group[i].address.toLowerCase()] = v;
      });
    }
  }
  return makeSnapshot(data);
}

/* ------------------------------------------------------------------------------------------------ */
/* Upgrade Tripwire: new-implementation bytecode                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface ImplCode { address: string; isContract: boolean; byteSize: number; selectors: string[] }

/** Pseudo-selector for the SELFDESTRUCT opcode so upgrades that add it show up in the diff. */
export const OP_SELFDESTRUCT = "op:selfdestruct";

/** Risky selector set (bytecode-signatures RISKY_SELECTORS hits + SELFDESTRUCT) of the code at `address`. */
export async function fetchImplCode(chainId: ChainId, address: string): Promise<ImplCode> {
  const client = getPublicClientForChain(chainId);
  const code = await withRetry(() => client.getCode({ address: getAddress(address) }));
  const insp = inspectRawBytecode(code);
  const selectors = insp.matchedSelectors.map((s) => s.selector);
  if (insp.hasSelfdestruct) selectors.push(OP_SELFDESTRUCT);
  return { address: address.toLowerCase(), isContract: insp.isContract, byteSize: insp.byteSize, selectors: [...new Set(selectors)].sort() };
}

const BEACON_ABI = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** Address of the logic currently selected by a watch's proxy slots in this snapshot (impl, else OZ impl, else beacon's impl). */
export function currentLogicSlots(w: Watch, snap: ChainSnapshot): { impl: string | null; ozImpl: string | null; beacon: string | null } {
  const has = (n: keyof typeof SLOTS) => w.meta.proxy?.slots.includes(n as never) ?? false;
  return {
    impl: has("eip1967Impl") ? parseAddressFromSlot(snap.slot(w.target, SLOTS.eip1967Impl)) : null,
    ozImpl: has("ozImpl") ? parseAddressFromSlot(snap.slot(w.target, SLOTS.ozImpl)) : null,
    beacon: has("eip1967Beacon") ? parseAddressFromSlot(snap.slot(w.target, SLOTS.eip1967Beacon)) : null,
  };
}

/**
 * For proxies whose implementation / beacon slot changed vs the stored state, fetch the new logic's
 * bytecode and risky selector set (rare; one getCode each). Keys are lowercase logic addresses; a
 * beacon change is resolved through `beacon.implementation()` and keyed by the beacon address.
 * Pass the result as `EvalContext.newImplCode`.
 */
export async function prefetchChangedImpls(
  watches: Watch[],
  states: Record<string, WatchState | undefined>,
  snaps: Partial<Record<ChainId, ChainSnapshot>>
): Promise<Record<string, ImplCode>> {
  const want = new Map<string, { chainId: ChainId; address: string; beacon: boolean }>();
  for (const w of watches) {
    if (!w.enabled || !w.meta.proxy || !w.rules.some((r) => r.type === "proxy_upgrade" && r.enabled)) continue;
    const snap = snaps[w.chainId];
    const code = states[w.id]?.code;
    if (!snap) continue;
    const cur = currentLogicSlots(w, snap);
    if (cur.impl && cur.impl !== (code?.impl ?? null)) want.set(cur.impl, { chainId: w.chainId, address: cur.impl, beacon: false });
    if (cur.ozImpl && cur.ozImpl !== (code?.ozImpl ?? null)) want.set(cur.ozImpl, { chainId: w.chainId, address: cur.ozImpl, beacon: false });
    if (cur.beacon && cur.beacon !== (code?.beacon ?? null)) want.set(cur.beacon, { chainId: w.chainId, address: cur.beacon, beacon: true });
  }
  const out: Record<string, ImplCode> = {};
  await Promise.all(
    [...want.values()].slice(0, 20).map(async (x) => {
      try {
        let logic = x.address;
        if (x.beacon) {
          logic = String(await getPublicClientForChain(x.chainId).readContract({ address: getAddress(x.address), abi: BEACON_ABI, functionName: "implementation" })).toLowerCase();
        }
        out[x.address] = await fetchImplCode(x.chainId, logic);
      } catch {
        /* evaluator reports "selector diff unavailable" honestly */
      }
    })
  );
  return out;
}
