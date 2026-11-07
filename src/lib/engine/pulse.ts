import { type Address, hexToBigInt, numberToHex, type PublicClient } from "viem";
import { BASE_SPENDERS, BASE_TRACKED_TOKENS, CONTRACTS, ROBINHOOD_SPENDERS, ROBINHOOD_TRACKED_TOKENS } from "@/config/contracts";
import { cached } from "@/lib/cache";
import { kvSetJson } from "@/lib/kv";
import { getRibbonTelemetryCached } from "@/lib/ribbon";
import { baseLogsClient, basePublicClient, robinhoodPublicClient } from "@/lib/rpc";
import { errMsg } from "./chain-utils";
import { getLogsChunked } from "./logs";
import { classifyLogs, contactLabel, type DecodeCtx, type RpcLogLike, rhPerBlockGas } from "./pulse-decode";
import type { Pulse, PulseChain, PulseContact, PulseEvent, PulseLastContact, PulseParity, PulseSpan } from "./pulse-types";

/**
 * Sentinel Watch feed (GET /api/pulse). One aggregated read per refresh, memoised IN-PROCESS (never KV on the fast
 * or long path) so RPC load is constant regardless of visitor count; the CDN in front of the route does the rest.
 *
 *  fast  (1.5 s): Base batch[getBlock(latest), feeHistory(64)]  + getLogs(6 watched addresses, ~61 blocks)
 *                 RH   batch[getBlock(latest), feeHistory(128)] + getLogs(4 watched addresses, ~125 blocks)
 *  long  (10 s):  the same with 320 / 640 blocks (first paint + SSR snapshot)
 *  cadence (60 s per chain) and parity (15 s, ribbon telemetry) refresh in the BACKGROUND (never on the fast path);
 *  lastContact (10 min in-process, then KV 10 min).
 *
 * Every block in `gas` is a real block from eth_feeHistory (Base gasUsedRatio; Robinhood de-accumulated per-block gas);
 * every event is one real log.
 */

const WINDOWS: Record<PulseSpan, { base: number; rh: number }> = { short: { base: 64, rh: 128 }, long: { base: 320, rh: 640 } };
const LOGS_LAG = 3n;
const TTL = { fast: 1_500, long: 10_000, cadence: 60_000, parity: 15_000, lastContact: 600_000 } as const;
const EVENT_CAP: Record<PulseSpan, number> = { short: 80, long: 200 };
const DEFAULT_CADENCE = { base: 200, rh: 104 } as const;

const PERMIT2 = CONTRACTS.base.permit2.toLowerCase();
const BASE_CONTACT = [CONTRACTS.base.vibesToken, CONTRACTS.base.vibesAerodromePool, CONTRACTS.base.vibesBridgeAdapter, CONTRACTS.base.vibesGenesisEscrow, CONTRACTS.base.vibesTranchEscrowFactory].map(
  (a) => a.toLowerCase() as Address
);
const RH_CONTACT = [CONTRACTS.robinhood.vibesToken, CONTRACTS.robinhood.vibesUniswapV3Pool, CONTRACTS.robinhood.vibesReserveAdapter].map((a) => a.toLowerCase() as Address);
const BASE_WATCH = [PERMIT2 as Address, ...BASE_CONTACT];
const RH_WATCH = [PERMIT2 as Address, ...RH_CONTACT];

const lowerMap = (rows: readonly { address: string }[], val: (r: never) => string) =>
  Object.fromEntries(rows.map((r) => [r.address.toLowerCase(), val(r as never)])) as Record<string, string>;

// Per-chain label maps (never the merged SPENDER_LABELS: a Base router address on Robinhood may be unrelated code).
const CTX: Record<"base" | "rh", DecodeCtx> = {
  base: {
    chainId: 8453,
    permit2: PERMIT2,
    contact: new Set(BASE_CONTACT),
    vibestarter: new Set([CONTRACTS.base.vibesGenesisEscrow.toLowerCase(), CONTRACTS.base.vibesTranchEscrowFactory.toLowerCase()]),
    symbols: lowerMap(BASE_TRACKED_TOKENS, (r: { symbol: string }) => r.symbol),
    spenders: lowerMap(BASE_SPENDERS, (r: { name: string }) => r.name),
    swapLabel: "AERODROME SWAP",
  },
  rh: {
    chainId: 4663,
    permit2: PERMIT2,
    contact: new Set(RH_CONTACT),
    vibestarter: new Set(),
    symbols: lowerMap(ROBINHOOD_TRACKED_TOKENS, (r: { symbol: string }) => r.symbol),
    spenders: lowerMap(ROBINHOOD_SPENDERS, (r: { name: string }) => r.name),
    swapLabel: "UNISWAP V3 SWAP",
  },
};

// ── in-process memo (globalThis: survives dev HMR), with in-flight dedupe. Never touches KV. ──────────────────
const g = globalThis as typeof globalThis & {
  __kestrelPulseMemo?: Map<string, { at: number; value: unknown }>;
  __kestrelPulseInflight?: Map<string, Promise<unknown>>;
  __kestrelPulseLastContact?: PulseLastContact | null;
};
const store = (g.__kestrelPulseMemo ??= new Map());
const inflight = (g.__kestrelPulseInflight ??= new Map());

function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function stale<T>(key: string): T | null {
  return (store.get(key)?.value as T | undefined) ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

// ── chain window ─────────────────────────────────────────────────────────────────────────────────────────────
interface RawBlock {
  number: `0x${string}`;
  timestamp: `0x${string}`;
  timestampMs?: `0x${string}`;
}
interface RawFeeHistory {
  oldestBlock: `0x${string}`;
  baseFeePerGas: `0x${string}`[];
  gasUsedRatio: number[];
}

type ChainKey = "base" | "rh";

function blockTimeMs(b: RawBlock, preferMs: boolean): number {
  if (preferMs && b.timestampMs) return Number(hexToBigInt(b.timestampMs));
  return Number(hexToBigInt(b.timestamp)) * 1000;
}

/**
 * Measured block cadence, OFF the fast path: returns the last measurement (or the default) immediately and refreshes
 * in the background once the 60 s memo expires, so a cadence read never delays a /api/pulse response.
 */
function readCadence(chain: ChainKey, client: PublicClient, head: RawBlock): { ms: number; measured: boolean } {
  const key = `cad:${chain}`;
  void memo(key, TTL.cadence, async () => {
    const headN = hexToBigInt(head.number);
    const old = (await client.request({ method: "eth_getBlockByNumber", params: [numberToHex(headN - 1000n), false] } as never)) as RawBlock | null;
    if (!old) throw new Error("cadence block missing");
    const both = chain === "base" && !!head.timestampMs && !!old.timestampMs;
    const ms = (blockTimeMs(head, both) - blockTimeMs(old, both)) / 1000;
    if (!(ms > 0 && ms < 10_000)) throw new Error("cadence out of range");
    return { ms: Math.round(ms * 10) / 10, measured: true };
  }).catch(() => undefined);
  return stale<{ ms: number; measured: boolean }>(key) ?? { ms: DEFAULT_CADENCE[chain], measured: false };
}

function emptyChain(chain: ChainKey, error: string): PulseChain {
  return {
    chainId: chain === "base" ? 8453 : 4663,
    ok: false,
    logsOk: false,
    error,
    from: null,
    to: null,
    gas: [],
    baseFeeWei: null,
    anchor: null,
    cadenceMs: DEFAULT_CADENCE[chain],
    cadenceMeasured: false,
    logsTo: null,
    watched: chain === "base" ? BASE_WATCH.length : RH_WATCH.length,
  };
}

async function readChainWindow(chain: ChainKey, n: number): Promise<{ chain: PulseChain; events: PulseEvent[] }> {
  const client = chain === "base" ? basePublicClient : robinhoodPublicClient;
  const t0 = Date.now();
  let head: RawBlock;
  let fh: RawFeeHistory;
  let rtt: number;
  try {
    // Both clients batch JSON-RPC: these two calls go out as ONE HTTP POST and answer about the same head.
    [head, fh] = (await Promise.all([
      client.request({ method: "eth_getBlockByNumber", params: ["latest", false] } as never),
      client.request({ method: "eth_feeHistory", params: [numberToHex(n), "latest", []] } as never),
    ])) as [RawBlock, RawFeeHistory];
    rtt = Date.now() - t0;
    if (!head?.number || !fh?.oldestBlock || !Array.isArray(fh.gasUsedRatio) || fh.gasUsedRatio.length === 0) throw new Error("malformed head / feeHistory response");
  } catch (e) {
    return { chain: emptyChain(chain, errMsg(e)), events: [] };
  }

  const len = fh.gasUsedRatio.length;
  const oldest = hexToBigInt(fh.oldestBlock);
  const to = oldest + BigInt(len) - 1n;
  const baseFee = fh.baseFeePerGas?.[len - 1];
  const cadence = readCadence(chain, client, head);
  // Base: gasUsedRatio is gasUsed/gasLimit per block. Robinhood (Nitro): a per-second running sum ÷ 14M gas/s,
  // converted back to each block's own gas (see rhPerBlockGas); unknown blocks stay null.
  const gas: (number | null)[] =
    chain === "rh" ? rhPerBlockGas(fh.gasUsedRatio, cadence.ms) : fh.gasUsedRatio.map((r) => Math.round(Math.max(0, Number(r) || 0) * 10_000) / 10_000);

  const headN = hexToBigInt(head.number);
  let anchor: PulseChain["anchor"];
  if (chain === "base" && head.timestampMs) {
    anchor = { block: headN.toString(), timeMs: Number(hexToBigInt(head.timestampMs)), exact: true };
  } else {
    const tsMs = Number(hexToBigInt(head.timestamp)) * 1000;
    const est = t0 + rtt / 2 - cadence.ms / 2;
    anchor = { block: headN.toString(), timeMs: Math.round(Math.min(tsMs + 999, Math.max(tsMs, est))), exact: false };
  }

  const logsTo = to - LOGS_LAG;
  let logsOk = true;
  let error: string | null = null;
  let events: PulseEvent[] = [];
  if (logsTo >= oldest) {
    try {
      const logsClient = chain === "base" ? baseLogsClient : robinhoodPublicClient;
      // Hard 8 s deadline: the in-flight memo makes /api/pulse and the landing render wait on this one call.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const logs = (await Promise.race([
        logsClient.request({
          method: "eth_getLogs",
          params: [{ address: chain === "base" ? BASE_WATCH : RH_WATCH, fromBlock: numberToHex(oldest), toBlock: numberToHex(logsTo) }],
        } as never),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("eth_getLogs timed out (8 s)")), 8_000))),
      ]).finally(() => clearTimeout(timer))) as RpcLogLike[];
      events = classifyLogs(Array.isArray(logs) ? logs : [], CTX[chain]);
    } catch (e) {
      logsOk = false;
      error = errMsg(e);
    }
  }

  return {
    chain: {
      chainId: chain === "base" ? 8453 : 4663,
      ok: true,
      logsOk,
      error,
      from: oldest.toString(),
      to: to.toString(),
      gas,
      baseFeeWei: baseFee ? hexToBigInt(baseFee).toString() : null,
      anchor,
      cadenceMs: cadence.ms,
      cadenceMeasured: cadence.measured,
      logsTo: logsTo.toString(),
      watched: chain === "base" ? BASE_WATCH.length : RH_WATCH.length,
    },
    events,
  };
}

// ── parity (ribbon telemetry, 15 s; failures cached too) ─────────────────────────────────────────────────────
function readParity(): Promise<PulseParity | null> {
  return memo("pulse:parity", TTL.parity, () =>
    getRibbonTelemetryCached()
      .then((t): PulseParity => ({ status: t.parity, deltaRaw: t.deltaRaw, baseBlock: t.baseBlock, rhBlock: t.rhBlock, fetchedAt: t.fetchedAt }))
      .catch(() => null)
  );
}

// ── last $VIBES contact ──────────────────────────────────────────────────────────────────────────────────────
export function peekLastContact(): PulseLastContact | null {
  return g.__kestrelPulseLastContact ?? null;
}

function blockTimeMsOf(c: PulseChain, block: string): number {
  if (!c.anchor) return 0;
  return c.anchor.timeMs + (Number(block) - Number(c.anchor.block)) * c.cadenceMs;
}
function blockTimeSec(c: PulseChain, block: string): number {
  return Math.floor(blockTimeMsOf(c, block) / 1000);
}

/** A live contact newer than the stored one replaces it in process (and, fire-and-forget, in KV). */
function noteLiveContact(events: PulseEvent[], chains: Pulse["chains"]) {
  const cur = peekLastContact();
  if (!cur) return;
  let newest: PulseContact | null = null;
  for (const e of events) {
    if (!e.contact) continue;
    const c = e.chainId === 8453 ? chains.base : chains.rh;
    const ts = blockTimeSec(c, e.block);
    if (!newest || ts > newest.timestamp) newest = { chainId: e.chainId, block: e.block, tx: e.tx, kind: e.kind, label: contactLabel(e.kind, e.chainId === 8453 ? "AERODROME SWAP" : "UNISWAP V3 SWAP"), timestamp: ts };
  }
  if (!newest) return;
  if (cur.contact && cur.contact.timestamp >= newest.timestamp) return;
  const next: PulseLastContact = { ...cur, contact: newest };
  g.__kestrelPulseLastContact = next;
  void kvSetJson("cache:pulse:lastContact:v1", next, { ex: 600 }).catch(() => {});
}

async function computeLastContact(): Promise<PulseLastContact> {
  const [baseHead, rhHead] = await Promise.all([basePublicClient.getBlockNumber({ cacheTime: 0 }), robinhoodPublicClient.getBlockNumber({ cacheTime: 0 })]);
  const [baseRes, ...rhRes] = await Promise.all([
    getLogsChunked(8453, { address: BASE_CONTACT, fromBlock: baseHead - 864_000n, toBlock: baseHead }, { maxLogs: 1, timeBudgetMs: 6_000 }),
    ...RH_CONTACT.map((addr) => getLogsChunked(4663, { address: addr, fromBlock: rhHead - 1_660_000n, toBlock: rhHead }, { maxLogs: 1, timeBudgetMs: 6_000 })),
  ]);

  type Cand = { chain: ChainKey; blockNumber: bigint; tx: `0x${string}` };
  const cands: Cand[] = [];
  const push = (chain: ChainKey, logs: { blockNumber: bigint | null; transactionHash: `0x${string}` | null }[]) => {
    const l = logs[logs.length - 1];
    if (l?.blockNumber != null && l.transactionHash) cands.push({ chain, blockNumber: l.blockNumber, tx: l.transactionHash });
  };
  push("base", baseRes.logs);
  for (const r of rhRes) push("rh", r.logs);

  const resolved: PulseContact[] = [];
  // Newest per chain (block numbers are not comparable across chains; compare by block timestamp below).
  for (const chain of ["base", "rh"] as const) {
    const best = cands.filter((c) => c.chain === chain).sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))[0];
    if (!best) continue;
    const client = chain === "base" ? basePublicClient : robinhoodPublicClient;
    const [receipt, block] = await Promise.all([client.getTransactionReceipt({ hash: best.tx }), client.getBlock({ blockNumber: best.blockNumber })]);
    const ev = classifyLogs(receipt.logs as unknown as RpcLogLike[], CTX[chain]).find((e) => e.contact);
    const kind = ev?.kind ?? "VIBES_LOG";
    resolved.push({ chainId: chain === "base" ? 8453 : 4663, block: best.blockNumber.toString(), tx: best.tx.toLowerCase(), kind, label: contactLabel(kind, CTX[chain].swapLabel), timestamp: Number(block.timestamp) });
  }
  resolved.sort((a, b) => b.timestamp - a.timestamp);

  const rhFrom = rhRes.reduce<bigint | null>((acc, r) => (r.coveredFrom === null ? acc : acc === null || r.coveredFrom > acc ? r.coveredFrom : acc), null);
  const value: PulseLastContact = {
    contact: resolved[0] ?? null,
    scanned: {
      base: { from: baseRes.coveredFrom?.toString() ?? null, to: baseHead.toString(), complete: baseRes.complete || (baseRes.truncated && baseRes.logs.length > 0) },
      rh: { from: rhRes.some((r) => r.coveredFrom === null) ? null : (rhFrom?.toString() ?? null), to: rhHead.toString(), complete: rhRes.every((r) => r.complete || (r.truncated && r.logs.length > 0)) },
    },
  };
  return value;
}

/** Last $VIBES / OFT / Vibestarter contact across both chains (10 min in-process memo, then KV 10 min). */
export function getLastContact(): Promise<PulseLastContact> {
  return memo("pulse:lastContact", TTL.lastContact, () => cached("pulse:lastContact:v1", 600, computeLastContact)).then((v) => {
    const cur = peekLastContact();
    // Keep a live-observed newer contact rather than regressing to the history scan's answer.
    if (!cur || (v.contact?.timestamp ?? 0) >= (cur.contact?.timestamp ?? 0)) g.__kestrelPulseLastContact = v;
    return peekLastContact() ?? v;
  });
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────────────────
/** Parity is never awaited on a warm build (its 15 s refresh runs in the background); a cold build waits ≤ 300 ms. */
async function parityNow(): Promise<PulseParity | null> {
  if (!store.has("pulse:parity")) return withTimeout(readParity(), 300);
  void readParity();
  return stale<PulseParity | null>("pulse:parity");
}

async function buildPulse(span: PulseSpan): Promise<Pulse> {
  const w = WINDOWS[span];
  const [baseR, rhR, parity] = await Promise.all([
    Promise.allSettled([readChainWindow("base", w.base)]).then(([r]) => (r.status === "fulfilled" ? r.value : { chain: emptyChain("base", errMsg(r.reason)), events: [] })),
    Promise.allSettled([readChainWindow("rh", w.rh)]).then(([r]) => (r.status === "fulfilled" ? r.value : { chain: emptyChain("rh", errMsg(r.reason)), events: [] })),
    parityNow(),
  ]);
  const chains = { base: baseR.chain, rh: rhR.chain };
  const events = [...baseR.events, ...rhR.events].sort((a, b) => {
    const ta = blockTimeMsOf(a.chainId === 8453 ? chains.base : chains.rh, a.block) + a.logIndex / 1e4;
    const tb = blockTimeMsOf(b.chainId === 8453 ? chains.base : chains.rh, b.block) + b.logIndex / 1e4;
    return ta - tb;
  });
  const capped = events.length > EVENT_CAP[span] ? events.slice(-EVENT_CAP[span]) : events;
  noteLiveContact(capped, chains);
  return { v: 1, span, builtAt: Date.now(), chains, events: capped, parity, lastContact: peekLastContact() };
}

export function getPulse(span: PulseSpan): Promise<Pulse> {
  return span === "long" ? memo("pulse:long", TTL.long, () => buildPulse("long")) : memo("pulse:fast", TTL.fast, () => buildPulse("short"));
}

/** SSR snapshot for the landing hero: the long window plus (at most 4 s of waiting for) the last-contact scan. */
export async function getPulseSnapshot(): Promise<Pulse> {
  const [pulse, last] = await Promise.all([getPulse("long"), withTimeout(getLastContact(), 4_000)]);
  return { ...pulse, lastContact: last ?? pulse.lastContact ?? peekLastContact() };
}
