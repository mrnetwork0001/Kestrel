import { type AbiEvent, type Address, encodeEventTopics, formatLog, type Hex, type Log, pad, parseEventLogs, type ParseEventLogsReturnType } from "viem";
import { ROBINHOOD_FETCH_HEADERS } from "@/config/chains";
import { serverLogsRpcUrls } from "@/lib/rpc";
import type { ChainId } from "./types";

/**
 * Chunked, provider-aware eth_getLogs for Base (8453) and Robinhood Chain (4663).
 *
 * Verified provider limits (live probes, 2026-11-07):
 *  - base-rpc.publicnode.com: max 50,000 blocks per query (inclusive), an `address` filter is REQUIRED
 *    ("Please specify an address…"), address arrays are accepted, max 20,000 results per query.
 *    Recent ranges (~600k blocks) answer in ~100 ms; older ranges take 1–18 s per 50k chunk.
 *  - mainnet.base.org: eth_getLogs answers "-32011 request limit reached" even for 100 blocks → unusable.
 *  - rpc.mainnet.chain.robinhood.com: a single `address` (with or without topics) may span 10,000,000 blocks;
 *    an address ARRAY + topics is capped at 100,000 blocks; topic-only filters at 30,000 blocks;
 *    max 10,000 results per query; HTTP 429 under bursty load; needs the Kestrel User-Agent.
 *
 * Ranges are split to each provider's cap, run newest-first with bounded concurrency, retried on transient
 * errors, bisected on "too many results", re-split when a provider reports a smaller range cap, and every
 * result states exactly which block ranges were covered (`complete` / `partial`).
 *
 * Optional env: BASE_LOGS_RPC_URL (an indexed Base RPC, e.g. Alchemy/QuickNode — enables topic-only queries),
 * BASE_LOGS_MAX_RANGE (its block-range cap, default 10,000 for a custom URL).
 */

export type LogTopic = Hex | readonly Hex[] | null;

export interface LogsQuery {
  /** Contract address(es) to filter on. Required on Base public RPCs. */
  address?: Address | readonly Address[];
  /** Single event: decoded, and topics are built from `args` when `topics` is not given. */
  event?: AbiEvent;
  /** Several events: decoded; topic0 is OR'd across them when `topics` is not given. */
  events?: readonly AbiEvent[];
  /** Indexed-argument filter for `event` (or `events[0]` when only one event is given). */
  args?: Record<string, unknown> | readonly unknown[];
  /** Raw topics override (topic0 first). Use `addressTopic()` to pad addresses. */
  topics?: readonly LogTopic[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ChunkedLogsOptions {
  /** Stop once this many logs were collected (newest kept). Default 20,000. */
  maxLogs?: number;
  /** Parallel requests. Default: Base 4, Robinhood 2. */
  concurrency?: number;
  /** Retries per chunk on transient errors (429/timeout/5xx). Default 2. */
  retries?: number;
  /** Do not start new chunks after this many ms; unstarted ranges are reported as skipped. Default 12,000. */
  timeBudgetMs?: number;
  /** Per-request timeout in ms. Default 12,000. */
  requestTimeoutMs?: number;
  /** Override the computed chunk span (blocks per query). Clamped to the provider cap. */
  chunkSize?: bigint;
  /** Skip the in-memory cache of closed (finalized-ish) ranges. */
  noCache?: boolean;
  /**
   * Background work (e.g. post-response indexing): runs in its own small per-provider pool (2 in flight) so slow
   * historical chunks never queue ahead of interactive requests.
   */
  background?: boolean;
}

export interface BlockRange {
  from: bigint;
  to: bigint;
}

export interface ChunkedLogsResult<TLog> {
  /** Logs sorted ascending by (blockNumber, logIndex). */
  logs: TLog[];
  fromBlock: bigint;
  toBlock: bigint;
  /** Merged ranges that were fully read. */
  coveredRanges: BlockRange[];
  /** Lowest block of the contiguous covered range ending at `toBlock` (null if the newest chunk failed). */
  coveredFrom: bigint | null;
  coveredBlocks: bigint;
  failedRanges: (BlockRange & { error: string })[];
  /** Ranges never attempted (time budget or early stop). */
  skippedRanges: BlockRange[];
  /** True when the full requested range was read and nothing was truncated. */
  complete: boolean;
  partial: boolean;
  /** maxLogs reached; only the newest logs are returned. */
  truncated: boolean;
  /** Set when the provider refuses this filter shape entirely (e.g. topic-only on publicnode). */
  unsupported: string | null;
  requests: number;
  chunks: number;
  durationMs: number;
  provider: string;
  /** One-line human summary safe to show in the UI. */
  note: string;
}

type DecodedLog<TAbi extends readonly AbiEvent[]> = ParseEventLogsReturnType<TAbi, undefined, true>[number];

type FilterShape = "single-address" | "multi-address" | "topic-only";

interface Provider {
  chainId: ChainId;
  url: string;
  host: string;
  headers: Record<string, string>;
  span: Record<FilterShape, bigint | null>;
  maxResultsHint: number;
  concurrency: number;
  /** Max addresses per filter (larger arrays are split into groups). */
  maxAddresses: number;
  /** Process-wide cap on in-flight eth_getLogs requests to this provider. */
  globalConcurrency: number;
}

const BASE_PUBLICNODE = "https://base-rpc.publicnode.com";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/**
 * Log providers come from the SERVER-ONLY RPC config in rpc.ts (ROBINHOOD_RPC_URL(S), BASE_LOGS_RPC_URL) —
 * never from NEXT_PUBLIC_* variables, which are inlined into the browser bundle and must not hold keyed URLs.
 */
function providerFor(chainId: ChainId): Provider {
  if (chainId === 4663) {
    const url = serverLogsRpcUrls(4663)[0] || "https://rpc.mainnet.chain.robinhood.com";
    return {
      chainId,
      url,
      host: hostOf(url),
      headers: { ...ROBINHOOD_FETCH_HEADERS },
      span: { "single-address": 10_000_000n, "multi-address": 100_000n, "topic-only": 30_000n },
      maxResultsHint: 10_000,
      concurrency: 2,
      maxAddresses: 10,
      globalConcurrency: 4,
    };
  }
  const custom = process.env.BASE_LOGS_RPC_URL;
  if (custom) {
    const cap = BigInt(Math.max(1, Number(process.env.BASE_LOGS_MAX_RANGE || 10_000) || 10_000));
    return { chainId, url: custom, host: hostOf(custom), headers: {}, span: { "single-address": cap, "multi-address": cap, "topic-only": cap }, maxResultsHint: 10_000, concurrency: 4, maxAddresses: 1_000, globalConcurrency: 8 };
  }
  const url = serverLogsRpcUrls(8453).find((u) => u.includes("publicnode")) ?? BASE_PUBLICNODE;
  return { chainId, url, host: hostOf(url), headers: {}, span: { "single-address": 50_000n, "multi-address": 50_000n, "topic-only": null }, maxResultsHint: 20_000, concurrency: 4, maxAddresses: 10, globalConcurrency: 8 };
}

/** True when this chain's log provider accepts filters without an address (wallet-wide discovery). */
export function supportsTopicOnlyLogs(chainId: ChainId): boolean {
  const p = providerFor(chainId);
  return p.span["topic-only"] !== null && !learned.get(`${p.url}|topic-only`)?.unsupported;
}

/** Max blocks per query for a filter shape on this chain (null = shape unsupported). */
export function logRangeCap(chainId: ChainId, shape: FilterShape): bigint | null {
  const p = providerFor(chainId);
  const l = learned.get(`${p.url}|${shape}`);
  if (l?.unsupported) return null;
  return l?.span ?? p.span[shape];
}

/** Left-pad an address to a 32-byte topic. */
export function addressTopic(address: string): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

// ── process-wide state (survives Next dev HMR) ───────────────────────────────
interface Learned {
  span?: bigint;
  unsupported?: string;
}
type CacheEntry = { at: number; logs: unknown[] };
const g = globalThis as typeof globalThis & { __kestrelLogsLearned?: Map<string, Learned>; __kestrelLogsCache?: Map<string, CacheEntry> };
const learned = (g.__kestrelLogsLearned ??= new Map());
const chunkCache = (g.__kestrelLogsCache ??= new Map());
const CACHE_TTL_MS = 2 * 3600_000;
const CACHE_MAX = 600;
/** Size cap: total raw logs held across all cached ranges (raw JSON-RPC logs are ~1 KB each → ~150 MB worst case). */
const CACHE_MAX_LOGS = 150_000;
/** Ranges with more logs than this are not cached (busy-token Transfer chunks would crowd out everything else). */
const CACHE_MAX_LOGS_PER_RANGE = 2_000;
const gt = globalThis as typeof globalThis & { __kestrelLogsCacheTotal?: number };
function cacheTotal(): number {
  if (gt.__kestrelLogsCacheTotal === undefined) {
    let n = 0;
    for (const e of chunkCache.values()) n += (e as CacheEntry).logs.length;
    gt.__kestrelLogsCacheTotal = n;
  }
  return gt.__kestrelLogsCacheTotal;
}
function cacheDelete(key: string) {
  const e = chunkCache.get(key);
  if (!e) return;
  chunkCache.delete(key);
  gt.__kestrelLogsCacheTotal = Math.max(0, cacheTotal() - e.logs.length);
}
/** Ranges whose `to` is at least this far below the requested head are cached (reorg-safe on both L2s). */
const CACHE_SAFE_DEPTH = 600n;

function cacheGet(key: string): unknown[] | null {
  const e = chunkCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cacheDelete(key);
    return null;
  }
  chunkCache.delete(key);
  chunkCache.set(key, e);
  return e.logs;
}

function cacheSet(key: string, logs: unknown[]) {
  if (logs.length > CACHE_MAX_LOGS_PER_RANGE) return;
  cacheDelete(key);
  chunkCache.set(key, { at: Date.now(), logs });
  gt.__kestrelLogsCacheTotal = cacheTotal() + logs.length;
  // Evict oldest (LRU order) until both the entry-count and the total-logs caps hold.
  while (chunkCache.size > CACHE_MAX || cacheTotal() > CACHE_MAX_LOGS) {
    const first = chunkCache.keys().next().value;
    if (first === undefined) break;
    cacheDelete(first);
  }
}

// ── error classification ────────────────────────────────────────────────────
class RpcLogsError extends Error {
  constructor(
    message: string,
    readonly kind: "range" | "results" | "address-required" | "transient" | "fatal",
    readonly suggestedSpan: bigint | null = null
  ) {
    super(message);
  }
}

function classify(message: string, httpStatus?: number): RpcLogsError {
  const m = message.slice(0, 300);
  if (/specify an address/i.test(m)) return new RpcLogsError(m, "address-required");
  if (/max(imum)? results|exceeds limit of|more than \d+ results|too many (results|logs)|response size|query returned more than|log response size/i.test(m))
    return new RpcLogsError(m, "results");
  const span =
    /maximum block range:?\s*(\d+)/i.exec(m) ??
    /only (\d+) are allowed/i.exec(m) ??
    /ranges over (\d+) blocks/i.exec(m) ??
    /up to a (\d+) block range/i.exec(m) ??
    /limited to 0 ?- ?(\d+) blocks/i.exec(m);
  if (span || /block range|query spans|range (is )?too (large|wide)/i.test(m)) return new RpcLogsError(m, "range", span ? BigInt(span[1]) : null);
  if (httpStatus === 429 || /429|too many requests|rate.?limit|request limit reached|timeout|timed out|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket|50[0-4]|bad gateway|unavailable|-32005|internal error/i.test(m))
    return new RpcLogsError(m, "transient");
  return new RpcLogsError(m, "fatal");
}

/**
 * Splits [fromBlock, toBlock] into `span`-sized ranges, newest first. Kept out of getLogsChunked on purpose: when the
 * queue was a local `[]` literal, the @vercel/nft static evaluator resolved `queue.shift()` and crashed `next build`
 * on `r.to - r.from + 1n` (NaN + BigInt). A function result is opaque to it.
 */
function newestFirstRanges(fromBlock: bigint, toBlock: bigint, span: bigint): BlockRange[] {
  const out: BlockRange[] = [];
  for (let to = toBlock; to >= fromBlock; ) {
    const from = to - span + 1n > fromBlock ? to - span + 1n : fromBlock;
    out.push({ from, to });
    if (from === 0n) break;
    to = from - 1n;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The caller's deadline passed while waiting for a provider slot: the range is reported as not reached. */
class SlotTimeoutError extends Error {
  constructor() {
    super("timed out waiting for an RPC slot");
  }
}

/**
 * Process-wide per-provider semaphore so concurrent scans don't stampede a public RPC into 429s. Waiting honours
 * the caller's deadline (no unbounded queueing past timeBudgetMs), and a released slot is handed directly to the
 * next waiter so a new arrival can never over-subscribe the provider in between.
 */
const gs = globalThis as typeof globalThis & { __kestrelLogsSem?: Map<string, { active: number; waiters: (() => void)[] }> };
const sems = (gs.__kestrelLogsSem ??= new Map());
async function withSlot<T>(p: Provider, fn: () => Promise<T>, background = false, deadline?: number): Promise<T> {
  const key = background ? `${p.url}|bg` : p.url;
  const limit = background ? 2 : p.globalConcurrency;
  let s = sems.get(key);
  if (!s) sems.set(key, (s = { active: 0, waiters: [] }));
  const sem = s;
  if (sem.active >= limit) {
    const handed = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      if (deadline !== undefined) {
        timer = setTimeout(() => {
          const i = sem.waiters.indexOf(waiter);
          if (i >= 0) sem.waiters.splice(i, 1);
          resolve(false);
        }, Math.max(0, deadline - Date.now()));
      }
      sem.waiters.push(waiter);
    });
    if (!handed) throw new SlotTimeoutError();
    // handed over by the releaser: `active` already counts this request
  } else sem.active++;
  try {
    return await fn();
  } finally {
    const next = sem.waiters.shift();
    if (next) next();
    else sem.active--;
  }
}

let rpcId = 1;
async function rpcGetLogs(p: Provider, filter: Record<string, unknown>, timeoutMs: number): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...p.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "eth_getLogs", params: [filter] }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw classify(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  const text = await res.text().catch(() => "");
  let body: { result?: unknown; error?: { code?: number; message?: string } } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw classify(`HTTP ${res.status} ${text.slice(0, 120)}`, res.status);
  }
  if (body?.error) throw classify(`${body.error.code ?? ""} ${body.error.message ?? "RPC error"}`.trim(), res.status);
  if (!Array.isArray(body?.result)) throw classify(`HTTP ${res.status} malformed eth_getLogs response`, res.status);
  return body.result;
}

function toHex(n: bigint): Hex {
  return `0x${n.toString(16)}`;
}

function mergeRanges(ranges: BlockRange[]): BlockRange[] {
  const s = [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: BlockRange[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1n) {
      if (r.to > last.to) last.to = r.to;
    } else out.push({ ...r });
  }
  return out;
}

/** Subtract `covered` ranges from [from, to] → missing ranges, newest first. */
export function missingRanges(from: bigint, to: bigint, covered: BlockRange[]): BlockRange[] {
  const merged = mergeRanges(covered.filter((r) => r.to >= from && r.from <= to));
  const out: BlockRange[] = [];
  let cursor = from;
  for (const r of merged) {
    if (r.from > cursor) out.push({ from: cursor, to: r.from - 1n });
    if (r.to + 1n > cursor) cursor = r.to + 1n;
    if (cursor > to) break;
  }
  if (cursor <= to) out.push({ from: cursor, to });
  return out.reverse();
}

export { mergeRanges };

function buildTopics(q: LogsQuery, events: readonly AbiEvent[] | null): readonly LogTopic[] | undefined {
  if (q.topics) return q.topics;
  if (!events || events.length === 0) return undefined;
  if (events.length === 1) {
    const t = encodeEventTopics({ abi: [events[0]] as readonly AbiEvent[], eventName: events[0].name, args: q.args } as unknown as Parameters<typeof encodeEventTopics>[0]);
    return t as readonly LogTopic[];
  }
  const sel = events.map((e) => encodeEventTopics({ abi: [e] as readonly AbiEvent[], eventName: e.name } as unknown as Parameters<typeof encodeEventTopics>[0])[0] as Hex);
  return [sel];
}

function shapeOf(address: LogsQuery["address"]): FilterShape {
  if (!address) return "topic-only";
  if (typeof address === "string") return "single-address";
  return address.length === 1 ? "single-address" : address.length === 0 ? "topic-only" : "multi-address";
}

/**
 * eth_getLogs over an arbitrary block range, split to the chain provider's limits.
 * Pass `event` or `events` to get decoded logs (strict: logs that don't match the ABI are dropped).
 */
export async function getLogsChunked<const TEvent extends AbiEvent>(
  chainId: ChainId,
  query: LogsQuery & { event: TEvent; events?: undefined },
  opts?: ChunkedLogsOptions
): Promise<ChunkedLogsResult<DecodedLog<readonly [TEvent]>>>;
export async function getLogsChunked<const TAbi extends readonly AbiEvent[]>(
  chainId: ChainId,
  query: LogsQuery & { events: TAbi; event?: undefined },
  opts?: ChunkedLogsOptions
): Promise<ChunkedLogsResult<DecodedLog<TAbi>>>;
export async function getLogsChunked(chainId: ChainId, query: LogsQuery, opts?: ChunkedLogsOptions): Promise<ChunkedLogsResult<Log>>;
export async function getLogsChunked(chainId: ChainId, query: LogsQuery, opts: ChunkedLogsOptions = {}): Promise<ChunkedLogsResult<unknown>> {
  const p = providerFor(chainId);
  const addrs = query.address === undefined || typeof query.address === "string" ? null : [...new Set(query.address.map((a) => a.toLowerCase() as Address))];
  if (!addrs || addrs.length <= p.maxAddresses) return getLogsChunkedOne(chainId, addrs ? { ...query, address: addrs } : query, opts);
  // Provider caps addresses per filter (publicnode: 10) → split into groups, run in parallel, merge coverage.
  const groups: Address[][] = [];
  for (let i = 0; i < addrs.length; i += p.maxAddresses) groups.push(addrs.slice(i, i + p.maxAddresses));
  const perGroupConc = Math.max(1, Math.floor((opts.concurrency ?? p.concurrency) / Math.min(groups.length, 2)));
  const parts = await Promise.all(groups.map((g) => getLogsChunkedOne(chainId, { ...query, address: g }, { ...opts, concurrency: perGroupConc })));
  return mergeGroupResults(query, parts, opts.maxLogs ?? 20_000);
}

function intersectRanges(a: BlockRange[], b: BlockRange[]): BlockRange[] {
  const out: BlockRange[] = [];
  for (const x of a)
    for (const y of b) {
      const from = x.from > y.from ? x.from : y.from;
      const to = x.to < y.to ? x.to : y.to;
      if (from <= to) out.push({ from, to });
    }
  return mergeRanges(out);
}

function mergeGroupResults(query: LogsQuery, parts: ChunkedLogsResult<unknown>[], maxLogs: number): ChunkedLogsResult<unknown> {
  const first = parts[0];
  let covered = first.coveredRanges;
  for (const p of parts.slice(1)) covered = intersectRanges(covered, p.coveredRanges);
  const top = covered[covered.length - 1];
  type L = { blockNumber?: bigint | null; logIndex?: number | null };
  let logs = parts.flatMap((p) => p.logs) as L[];
  logs.sort((a, b) => {
    const ab = a.blockNumber ?? 0n;
    const bb = b.blockNumber ?? 0n;
    if (ab !== bb) return ab < bb ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
  const truncated = parts.some((p) => p.truncated) || logs.length > maxLogs;
  if (logs.length > maxLogs) logs = logs.slice(-maxLogs);
  const failedRanges = parts.flatMap((p) => p.failedRanges);
  const skippedRanges = mergeRanges(parts.flatMap((p) => p.skippedRanges));
  const unsupported = parts.find((p) => p.unsupported)?.unsupported ?? null;
  const complete = parts.every((p) => p.complete) && !truncated;
  const coveredBlocks = covered.reduce((s, r) => s + (r.to - r.from + 1n), 0n);
  const blocks = query.toBlock - query.fromBlock + 1n;
  const chunks = parts.reduce((s, p) => s + p.chunks, 0);
  return {
    logs,
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
    coveredRanges: covered,
    coveredFrom: top && top.to === query.toBlock ? top.from : null,
    coveredBlocks,
    failedRanges,
    skippedRanges,
    complete,
    partial: !complete,
    truncated,
    unsupported,
    requests: parts.reduce((s, p) => s + p.requests, 0),
    chunks,
    durationMs: Math.max(...parts.map((p) => p.durationMs)),
    provider: first.provider,
    note: unsupported
      ? unsupported
      : complete
        ? `${logs.length} logs over ${blocks.toLocaleString("en-US")} blocks (#${query.fromBlock}–#${query.toBlock}), ${parts.length} address groups × chunks = ${chunks} queries via ${first.provider}.`
        : `Partial: ${coveredBlocks.toLocaleString("en-US")} of ${blocks.toLocaleString("en-US")} blocks read for all ${parts.length} address groups${truncated ? `, capped at the newest ${maxLogs.toLocaleString("en-US")} logs` : ""}${failedRanges.length ? `, ${failedRanges.length} range(s) failed (${failedRanges[0].error.slice(0, 60)})` : ""} via ${first.provider}.`,
  };
}

async function getLogsChunkedOne(chainId: ChainId, query: LogsQuery, opts: ChunkedLogsOptions): Promise<ChunkedLogsResult<unknown>> {
  const started = Date.now();
  const p = providerFor(chainId);
  const events = query.event ? [query.event] : query.events && query.events.length ? query.events : null;
  const topics = buildTopics(query, events);
  const address = query.address === undefined ? undefined : typeof query.address === "string" ? query.address : query.address.length === 1 ? query.address[0] : [...query.address];
  // Robinhood caps OR'd topic filters (an array in any topic position) like address arrays: 100k blocks.
  const hasOr = !!topics?.some((t) => Array.isArray(t) && t.length > 1);
  const baseShape = shapeOf(query.address);
  const shape: FilterShape = chainId === 4663 && hasOr && baseShape === "single-address" ? "multi-address" : baseShape;
  const maxLogs = opts.maxLogs ?? 20_000;
  const retries = opts.retries ?? 2;
  const budget = opts.timeBudgetMs ?? 12_000;
  const reqTimeout = opts.requestTimeoutMs ?? 12_000;
  const concurrency = Math.max(1, opts.concurrency ?? p.concurrency);
  const learnKey = `${p.url}|${shape}${hasOr ? "+or" : ""}`;

  const result: ChunkedLogsResult<unknown> = {
    logs: [],
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
    coveredRanges: [],
    coveredFrom: null,
    coveredBlocks: 0n,
    failedRanges: [],
    skippedRanges: [],
    complete: false,
    partial: true,
    truncated: false,
    unsupported: null,
    requests: 0,
    chunks: 0,
    durationMs: 0,
    provider: p.host,
    note: "",
  };
  if (query.toBlock < query.fromBlock) {
    result.complete = true;
    result.partial = false;
    result.note = "Empty block range.";
    return result;
  }

  const learnedShape = learned.get(learnKey);
  const cap = learnedShape?.unsupported ? null : (learnedShape?.span ?? p.span[shape]);
  if (cap === null) {
    const why = learnedShape?.unsupported ?? `${p.host} does not serve ${shape} log filters (an address filter is required).`;
    result.unsupported = why;
    result.skippedRanges = [{ from: query.fromBlock, to: query.toBlock }];
    result.note = why;
    result.durationMs = Date.now() - started;
    return result;
  }
  let span = opts.chunkSize && opts.chunkSize > 0n && opts.chunkSize < cap ? opts.chunkSize : cap;

  const queue = newestFirstRanges(query.fromBlock, query.toBlock, span);

  const collected: { range: BlockRange; logs: unknown[] }[] = [];
  let total = 0;
  let stop = false;
  const filterKeyBase = JSON.stringify({ a: address ?? null, t: topics ?? null });

  async function fetchRange(r: BlockRange): Promise<unknown[]> {
    const cacheKey = `${chainId}|${p.url}|${filterKeyBase}|${r.from}|${r.to}`;
    const cacheable = !opts.noCache && r.to + CACHE_SAFE_DEPTH <= query.toBlock;
    if (cacheable) {
      const hit = cacheGet(cacheKey);
      if (hit) return hit;
    }
    const filter: Record<string, unknown> = { fromBlock: toHex(r.from), toBlock: toHex(r.to) };
    if (address) filter.address = address;
    if (topics) filter.topics = topics;
    let attempt = 0;
    for (;;) {
      result.requests++;
      try {
        const logs = await withSlot(p, () => rpcGetLogs(p, filter, Math.min(reqTimeout, Math.max(2_000, budget + 4_000 - (Date.now() - started)))), opts.background, started + budget);
        if (cacheable) cacheSet(cacheKey, logs);
        return logs;
      } catch (e) {
        if (e instanceof SlotTimeoutError) throw e;
        const err = e instanceof RpcLogsError ? e : classify(String(e));
        if (err.kind === "transient" && attempt < retries && Date.now() - started < budget + 2_000) {
          attempt++;
          await sleep((/429|too many|rate|limit/i.test(err.message) ? 900 : 300) * attempt + Math.floor(Math.random() * 200));
          continue;
        }
        throw err;
      }
    }
  }

  async function worker() {
    while (!stop && queue.length) {
      if (Date.now() - started > budget) break;
      const r = queue.shift()!;
      try {
        const logs = await fetchRange(r);
        result.chunks++;
        collected.push({ range: r, logs });
        total += logs.length;
        if (total >= maxLogs) {
          stop = true;
          result.truncated = true;
        }
      } catch (e) {
        if (e instanceof SlotTimeoutError) {
          queue.unshift(r); // reported as a skipped range (time budget), never as covered
          break;
        }
        const err = e instanceof RpcLogsError ? e : classify(String(e));
        const width = r.to - r.from + 1n;
        if (err.kind === "address-required") {
          learned.set(learnKey, { unsupported: `${p.host} requires an address filter for eth_getLogs.` });
          result.unsupported = `${p.host} requires an address filter for eth_getLogs.`;
          stop = true;
          queue.unshift(r);
        } else if (err.kind === "range" && width > 1n) {
          const next = err.suggestedSpan && err.suggestedSpan > 0n && err.suggestedSpan < width ? err.suggestedSpan : width / 2n;
          if (next < span) {
            span = next;
            learned.set(learnKey, { span: next });
          }
          const parts: BlockRange[] = [];
          for (let to = r.to; to >= r.from; ) {
            const from = to - next + 1n > r.from ? to - next + 1n : r.from;
            parts.push({ from, to });
            if (from === r.from) break;
            to = from - 1n;
          }
          queue.unshift(...parts);
        } else if (err.kind === "results" && width > 1n) {
          const mid = r.from + width / 2n;
          queue.unshift({ from: mid, to: r.to }, { from: r.from, to: mid - 1n });
        } else {
          result.failedRanges.push({ ...r, error: err.message.slice(0, 160) });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  result.skippedRanges = mergeRanges(queue);
  result.coveredRanges = mergeRanges(collected.map((c) => c.range));
  result.coveredBlocks = result.coveredRanges.reduce((s, r) => s + (r.to - r.from + 1n), 0n);
  const top = result.coveredRanges[result.coveredRanges.length - 1];
  result.coveredFrom = top && top.to === query.toBlock ? top.from : null;

  // newest chunks first so truncation keeps the most recent logs
  collected.sort((a, b) => (a.range.from > b.range.from ? -1 : 1));
  let raw: unknown[] = [];
  for (const c of collected) {
    raw.push(...c.logs);
    if (raw.length >= maxLogs) break;
  }
  let formatted = raw.map((l) => formatLog(l as Parameters<typeof formatLog>[0]) as Log);
  formatted.sort((a, b) => {
    const ab = a.blockNumber ?? 0n;
    const bb = b.blockNumber ?? 0n;
    if (ab !== bb) return ab < bb ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
  if (formatted.length > maxLogs) formatted = formatted.slice(-maxLogs);
  raw = [];
  result.logs = events ? (parseEventLogs({ abi: events as readonly AbiEvent[], logs: formatted, strict: true }) as unknown[]) : formatted;

  result.complete = !result.unsupported && !result.truncated && result.failedRanges.length === 0 && result.skippedRanges.length === 0;
  result.partial = !result.complete;
  result.durationMs = Date.now() - started;
  const blocks = query.toBlock - query.fromBlock + 1n;
  result.note = result.unsupported
    ? result.unsupported
    : result.complete
      ? `${result.logs.length} logs over ${blocks.toLocaleString("en-US")} blocks (#${query.fromBlock}–#${query.toBlock}) in ${result.chunks} chunk${result.chunks === 1 ? "" : "s"} via ${p.host}.`
      : `Partial: ${result.coveredBlocks.toLocaleString("en-US")} of ${blocks.toLocaleString("en-US")} blocks read${result.truncated ? `, capped at the newest ${maxLogs.toLocaleString("en-US")} logs` : ""}${result.failedRanges.length ? `, ${result.failedRanges.length} range(s) failed (${result.failedRanges[0].error.slice(0, 60)})` : ""}${result.skippedRanges.length && !result.truncated ? `, ${result.skippedRanges.length} range(s) not reached (time budget)` : ""} via ${p.host}.`;
  return result;
}
