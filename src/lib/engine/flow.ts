import { type Address, getAddress, parseAbi } from "viem";
import { KNOWN_LABELS, SPENDER_LABELS } from "@/config/contracts";
import { ERC20_ABI } from "@/lib/abis";
import { after } from "next/server";
import { kvDel, kvGetJson, kvSet, kvSetJson } from "@/lib/kv";
import { getPublicClientForChain } from "@/lib/rpc";
import { blockAtTimestamp, blockHoursAgo } from "./chain-utils";
import { type BlockRange, getLogsChunked, mergeRanges, missingRanges } from "./logs";
import { OVERNIGHT_HOURS } from "./pools";
import type { ChainId, HolderScanCoverage, LogCoverage, OvernightTokenFlow, TokenHolder, TokenMeta } from "./types";

const TRANSFER_EVENT = ERC20_ABI.find((x) => x.type === "event" && x.name === "Transfer") as Extract<(typeof ERC20_ABI)[number], { type: "event"; name: "Transfer" }>;
const POOL_PROBE_ABI = parseAbi(["function token0() view returns (address)"]);

const MAX_LOGS = 20_000;
/** Holder discovery looks back this far in Transfer history (accumulated across scans in KV). */
/** Base: 30 days (older 50k-block chunks are slow on the public RPC, so the KV index fills in over a few scans).
 *  Robinhood: the whole chain (a single-address query spans 10M blocks → ~11 cheap queries). */
const HOLDER_WINDOW_DAYS: Record<ChainId, number | null> = { 8453: 30, 4663: null };
const HOLDER_INDEX_MAX = 1_500;
const HOLDER_INDEX_TTL_SEC = 14 * 86_400;
const CANDIDATES_FROM_HISTORY = 300;
const CANDIDATES_FROM_OVERNIGHT = 100;
const TOP_N = 10;
/** Per-scan time spent extending the holder index into older history (Base: older 50k-block chunks take 1–18 s each). */
const HISTORY_BUDGET_MS = 2_500;
/** Recent Base ranges the public RPC serves quickly (~100–300 ms per 50k-block chunk). */
const FAST_RECENT_BLOCKS = 500_000n;
/** Background (post-response) indexing budget per scan. */
const BACKGROUND_BUDGET_MS = 25_000;

/** Singleton vaults / pool managers that custody many pools' tokens (not whales). */
const VAULTS = new Set(
  [
    "0x498581fF718922c3f8e6A244956aF099B2652b2b", // Uniswap v4 PoolManager (Base)
    "0x8366a39CC670B4001A1121B8F6A443A643e40951", // Uniswap v4 PoolManager (Robinhood, from the RH v4 router's poolManager())
    "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Balancer V2 Vault
    "0xbA1333333333a1BA1108E8412f11850A5C319bA9", // Balancer V3 Vault
  ].map((a) => a.toLowerCase())
);

interface HolderIndex {
  v: 1;
  /** Covered block ranges as decimal-string pairs. */
  ranges: [string, string][];
  /** address → total received (raw units, decimal string) inside the covered ranges. */
  recv: Record<string, string>;
  updatedAt: number;
}

function idxKey(chainId: ChainId, token: string) {
  return `holders:v2:${chainId}:${token.toLowerCase()}`;
}

function coverageOf(r: { fromBlock: bigint; toBlock: bigint; coveredFrom: bigint | null; complete: boolean; chunks: number; failedRanges: unknown[]; truncated: boolean; provider: string; note: string }): LogCoverage {
  return {
    fromBlock: r.fromBlock.toString(),
    toBlock: r.toBlock.toString(),
    coveredFromBlock: r.coveredFrom?.toString() ?? null,
    complete: r.complete,
    chunks: r.chunks,
    failedRanges: r.failedRanges.length,
    truncated: r.truncated,
    provider: r.provider,
    note: r.note,
  };
}

type TransferLog = { args: { from?: string; to?: string; value?: bigint }; transactionHash: string | null; blockNumber: bigint | null };

function addRecv(recv: Map<string, bigint>, logs: TransferLog[]) {
  for (const l of logs) {
    const to = l.args.to?.toLowerCase();
    if (!to) continue;
    recv.set(to, (recv.get(to) ?? 0n) + (l.args.value ?? 0n));
  }
}

async function extendIndex(chainId: ChainId, token: Address, windowFrom: bigint, head: bigint, recv: Map<string, bigint>, coveredIn: BlockRange[], budgetMs: number, requestTimeoutMs: number, background = false): Promise<{ covered: BlockRange[]; note: string }> {
  let covered = coveredIn;
  let note = "";
  const deadline = Date.now() + budgetMs;
  for (const m of missingRanges(windowFrom, head, covered)) {
    const left = deadline - Date.now();
    if (left < 400) break;
    const r = await getLogsChunked(chainId, { address: token, event: TRANSFER_EVENT, fromBlock: m.from, toBlock: m.to }, { maxLogs: 10_000, timeBudgetMs: left, requestTimeoutMs, background, concurrency: background ? 2 : undefined }).catch(() => null);
    if (!r) continue;
    addRecv(recv, r.logs as unknown as TransferLog[]);
    if (r.truncated) {
      // too many logs to attribute to exact ranges → keep the candidates, don't mark the gap covered
      note = "History gap too busy to index fully; candidates kept.";
      break;
    }
    covered = mergeRanges([...covered, ...r.coveredRanges]);
  }
  return { covered, note };
}

async function saveIndex(chainId: ChainId, token: Address, recv: Map<string, bigint>, covered: BlockRange[]) {
  const keep = [...recv.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, HOLDER_INDEX_MAX);
  const toStore: HolderIndex = { v: 1, ranges: covered.map((r) => [r.from.toString(), r.to.toString()]), recv: Object.fromEntries(keep.map(([a, v]) => [a, v.toString()])), updatedAt: Date.now() };
  await kvSetJson(idxKey(chainId, token), toStore, { ex: HOLDER_INDEX_TTL_SEC }).catch(() => undefined);
}

/**
 * Keep indexing older Transfer history after the response is sent (Next `after()`; detached promise outside a
 * request scope). One runner per token at a time (KV NX lock); results land in the KV index for the next scan.
 */
function scheduleBackgroundExtension(chainId: ChainId, token: Address, windowFrom: bigint, head: bigint) {
  const run = async () => {
    const lockKey = `holders:lock:${chainId}:${token.toLowerCase()}`;
    const got = await kvSet(lockKey, "1", { ex: 90, nx: true }).catch(() => false);
    if (!got) return;
    try {
      const idx = await kvGetJson<HolderIndex>(idxKey(chainId, token)).catch(() => null);
      const recv = new Map<string, bigint>();
      let covered: BlockRange[] = [];
      if (idx?.v === 1) {
        for (const [a, v] of Object.entries(idx.recv)) recv.set(a, BigInt(v));
        covered = idx.ranges.map(([f, t]) => ({ from: BigInt(f), to: BigInt(t) }));
      }
      const ext = await extendIndex(chainId, token, windowFrom, head, recv, covered, BACKGROUND_BUDGET_MS, 20_000, true);
      await saveIndex(chainId, token, recv, ext.covered);
    } finally {
      await kvDel(lockKey).catch(() => 0);
    }
  };
  const task = () => run().catch(() => undefined);
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * Overnight token flow + whale discovery from live Transfer logs (no indexer):
 *  - 8h Transfer logs, chunked to the RPC's range cap (Base: 3 × 48k-block queries at 200 ms blocks)
 *  - holder candidates from a 14-day Transfer history, accumulated across scans in a KV "holder index"
 *    (newest ranges first under a time budget, so dormant whales are found too — not only overnight-active ones)
 *  - candidates ranked by live balanceOf at the latest block; pools, vaults, bridges, escrows and routers excluded
 */
export async function readOvernightFlow(chainId: ChainId, token: TokenMeta, exclude: string[] = []): Promise<OvernightTokenFlow> {
  const client = getPublicClientForChain(chainId);
  const tokenAddr = getAddress(token.address);
  const empty: OvernightTokenFlow = {
    available: false, hours: OVERNIGHT_HOURS, fromBlock: null, transferCount: 0, volume: "0", largestTransfer: "0", largestTransferTx: null, topHolder: null, note: "",
  };
  let latest: { number: bigint; timestamp: bigint };
  let fromBlock: bigint;
  try {
    latest = await client.getBlock({ blockTag: "latest" });
    fromBlock = await blockHoursAgo(chainId, client, latest.number, OVERNIGHT_HOURS);
  } catch (e) {
    return { ...empty, note: `Could not read the chain head: ${e instanceof Error ? e.message.slice(0, 100) : "RPC error"}.` };
  }

  const windowDays = HOLDER_WINDOW_DAYS[chainId];
  const windowLabel = windowDays === null ? "since genesis" : `in the last ${windowDays} days`;

  // ── 1 · overnight Transfer logs ───────────────────────────────────────────
  const [overnight, windowFromRes, idxRes] = await Promise.all([
    getLogsChunked(chainId, { address: tokenAddr, event: TRANSFER_EVENT, fromBlock, toBlock: latest.number }, { maxLogs: MAX_LOGS, timeBudgetMs: 9_000 }).catch(() => null),
    windowDays === null
      ? Promise.resolve(0n)
      : // hour-aligned so the block lookup is cached (10 min) instead of recomputed every scan
        blockAtTimestamp(chainId, client, Math.floor((Number(latest.timestamp) - windowDays * 86_400) / 3600) * 3600, latest).catch(() => blockHoursAgo(chainId, client, latest.number, windowDays * 24)).catch(() => null),
    kvGetJson<HolderIndex>(idxKey(chainId, tokenAddr)).catch(() => null),
  ]);
  const logs = (overnight?.logs ?? []) as unknown as TransferLog[];
  let volume = 0n;
  let largest = 0n;
  let largestTx: string | null = null;
  const touched = new Map<string, bigint>();
  for (const l of logs) {
    const v = l.args.value ?? 0n;
    volume += v;
    if (v > largest) {
      largest = v;
      largestTx = l.transactionHash;
    }
    for (const a of [l.args.from, l.args.to]) {
      if (!a) continue;
      const k = a.toLowerCase();
      touched.set(k, (touched.get(k) ?? 0n) + v);
    }
  }
  const overnightReadable = !!overnight && overnight.coveredFrom !== null;

  // ── 2 · holder index (14-day Transfer history, accumulated across scans) ──
  let holderScan: HolderScanCoverage | undefined;
  const recv = new Map<string, bigint>();
  let covered: BlockRange[] = [];
  try {
    if (windowFromRes === null) throw new Error("holder window unavailable");
    const windowFrom = windowFromRes;
    const idx = idxRes;
    if (idx?.v === 1) {
      for (const [a, v] of Object.entries(idx.recv)) recv.set(a, BigInt(v));
      covered = idx.ranges.map(([f, t]) => ({ from: BigInt(f), to: BigInt(t) }));
    }
    // fold in the overnight read (only fully-read ranges, never double-counting already-indexed blocks)
    if (overnight && !overnight.truncated) {
      const fresh = overnight.coveredRanges.flatMap((r) => missingRanges(r.from, r.to, covered));
      if (fresh.length) {
        addRecv(recv, logs.filter((l) => fresh.some((r) => l.blockNumber !== null && l.blockNumber >= r.from && l.blockNumber <= r.to)));
        covered = mergeRanges([...covered, ...fresh]);
      }
    }
    // Very busy tokens (overnight read truncated at MAX_LOGS) already yield thousands of candidates — skip history.
    const busy = !!overnight?.truncated;
    let extendNote = "";
    if (!busy) {
      // foreground: a short pass (recent ranges answer in ~100 ms); slow old ranges continue in the background
      // Base public RPC answers recent ranges fast but takes 1–18 s per older 50k-block chunk → foreground only
      // fills the recent part of the window; the rest is left to the background runner.
      const fgFrom = chainId === 8453 && latest.number - FAST_RECENT_BLOCKS > windowFrom ? latest.number - FAST_RECENT_BLOCKS : windowFrom;
      const ext = await extendIndex(chainId, tokenAddr, fgFrom, latest.number, recv, covered, HISTORY_BUDGET_MS, 3_000);
      covered = ext.covered;
      extendNote = ext.note;
    }
    await saveIndex(chainId, tokenAddr, recv, covered);
    if (!busy && missingRanges(windowFrom, latest.number, covered).length) scheduleBackgroundExtension(chainId, tokenAddr, windowFrom, latest.number);

    const inWindow = covered.filter((r) => r.to >= windowFrom).map((r) => ({ from: r.from < windowFrom ? windowFrom : r.from, to: r.to > latest.number ? latest.number : r.to }));
    const blocksCovered = inWindow.reduce((s, r) => s + (r.to - r.from + 1n), 0n);
    const blocksInWindow = latest.number - windowFrom + 1n;
    const complete = !busy && missingRanges(windowFrom, latest.number, covered).length === 0;
    holderScan = {
      method: "transfer-history",
      windowDays,
      windowFromBlock: windowFrom.toString(),
      toBlock: latest.number.toString(),
      blocksCovered: blocksCovered.toString(),
      blocksInWindow: blocksInWindow.toString(),
      complete,
      candidates: 0,
      balancesChecked: 0,
      note: busy
        ? `High-activity token: holder candidates come from the newest ${MAX_LOGS.toLocaleString("en-US")} overnight transfers.`
        : complete
          ? `Every Transfer ${windowLabel} indexed (#${windowFrom}–#${latest.number}).`
          : `${((Number((blocksCovered * 10_000n) / (blocksInWindow > 0n ? blocksInWindow : 1n))) / 100).toFixed(1)}% of the Transfer history ${windowLabel} indexed so far (newest first; each scan extends it).${extendNote ? ` ${extendNote}` : ""}`,
    };
  } catch {
    holderScan = undefined;
  }

  // ── 3 · rank candidates by live balanceOf ─────────────────────────────────
  const skip = new Set([...Object.keys(KNOWN_LABELS), ...Object.keys(SPENDER_LABELS), ...VAULTS, ...exclude.map((e) => e.toLowerCase()), tokenAddr.toLowerCase()]);
  const byRecv = [...recv.entries()].filter(([a]) => !skip.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, CANDIDATES_FROM_HISTORY).map(([a]) => a);
  const byOvernight = [...touched.entries()].filter(([a]) => !skip.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, CANDIDATES_FROM_OVERNIGHT).map(([a]) => a);
  const candidates = [...new Set([...byRecv, ...byOvernight])].map((a) => getAddress(a));
  if (holderScan) holderScan.candidates = candidates.length;

  let holders: TokenHolder[] = [];
  let topHolder: OvernightTokenFlow["topHolder"] = null;
  let holderError = "";
  if (candidates.length) {
    try {
      const bals = await client.multicall({
        allowFailure: true,
        blockNumber: latest.number,
        batchSize: 24_000,
        contracts: candidates.map((a) => ({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [a] as const })),
      });
      const ranked = candidates
        .map((a, i) => ({ address: a, balance: bals[i]?.status === "success" ? (bals[i].result as bigint) : 0n }))
        .filter((x) => x.balance > 0n)
        .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
        .slice(0, TOP_N + 5);
      if (holderScan) holderScan.balancesChecked = candidates.length;
      // classify the leaders: contract? AMM pool (token0())? → pools are liquidity, not whales
      const [codes, probes] = await Promise.all([
        Promise.all(ranked.map((r) => client.getCode({ address: r.address }).catch(() => undefined))),
        client.multicall({ allowFailure: true, contracts: ranked.map((r) => ({ address: r.address, abi: POOL_PROBE_ABI, functionName: "token0" as const })) }).catch(() => ranked.map(() => ({ status: "failure" as const }))),
      ]);
      const supply = BigInt(token.totalSupply);
      holders = ranked
        .map((r, i) => {
          const code = codes[i];
          const isContract = !!code && code !== "0x" && !code.startsWith("0xef0100");
          const isPool = isContract && probes[i]?.status === "success";
          return { r, isContract, isPool };
        })
        .filter((x) => !x.isPool)
        .slice(0, TOP_N)
        .map(({ r, isContract }) => ({
          address: r.address,
          balance: r.balance.toString(),
          shareBps: supply > 0n ? Number((r.balance * 10_000n) / supply) : 0,
          isContract,
          activeOvernight: touched.has(r.address.toLowerCase()),
        }));
      if (holders[0]) {
        const h = holders[0];
        topHolder = { address: h.address, balance: h.balance, shareBps: h.shareBps, isContract: h.isContract, activeOvernight: h.activeOvernight };
      }
    } catch (e) {
      holderError = ` Holder balance read failed: ${e instanceof Error ? e.message.slice(0, 80) : "RPC error"}.`;
    }
  }
  const topHoldersShareBps = holders.reduce((s, h) => s + h.shareBps, 0);

  const note = !overnight
    ? "Overnight Transfer log read failed."
    : overnight.complete
      ? `${logs.length} transfers since block #${fromBlock} (${overnight.chunks} chunk${overnight.chunks === 1 ? "" : "s"} via ${overnight.provider}).`
      : overnight.truncated
        ? `Analyzed the newest ${logs.length.toLocaleString("en-US")} transfers (window #${fromBlock}–#${latest.number}; older ones not read).`
        : overnight.note;

  return {
    available: overnightReadable,
    hours: OVERNIGHT_HOURS,
    fromBlock: fromBlock.toString(),
    transferCount: logs.length,
    volume: volume.toString(),
    largestTransfer: largest.toString(),
    largestTransferTx: largestTx,
    topHolder,
    note: note + holderError,
    holders,
    topHoldersShareBps,
    holderScan,
    overnightCoverage: overnight ? coverageOf(overnight) : undefined,
  };
}
