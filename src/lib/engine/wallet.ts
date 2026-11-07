import { type Address, getAddress, type Hex, isAddressEqual, parseAbi, toEventSelector, zeroAddress } from "viem";
import { CONTRACTS, PERMIT2_SPENDERS, SPENDER_LABELS, SPENDERS, TRACKED_TOKENS } from "@/config/contracts";
import { ERC20_ABI, PERMIT2_ABI } from "@/lib/abis";
import { inspectRawBytecode, PROXY_STORAGE_SLOTS } from "@/lib/bytecode-signatures";
import { isUnlimited } from "@/lib/format";
import { getPublicClientForChain } from "@/lib/rpc";
import { blockAtTimestamp, blockHoursAgo, readTokenMeta } from "./chain-utils";
import { addressTopic, type ChunkedLogsResult, getLogsChunked, supportsTopicOnlyLogs } from "./logs";
import { OVERNIGHT_HOURS } from "./pools";
import type { ApprovalCoverage, ApprovalExposure, ChainId, LogCoverage, TokenMeta, WalletAccountInfo, WalletReport } from "./types";

const ERC20_APPROVAL = ERC20_ABI.find((x) => x.type === "event" && x.name === "Approval") as Extract<(typeof ERC20_ABI)[number], { type: "event"; name: "Approval" }>;
const ERC20_TRANSFER = ERC20_ABI.find((x) => x.type === "event" && x.name === "Transfer") as Extract<(typeof ERC20_ABI)[number], { type: "event"; name: "Transfer" }>;

/** Permit2 events (owner is topic1 in both, like ERC-20 Approval → one OR'd topic0 query covers all three). */
const PERMIT2_EVENTS = parseAbi([
  "event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
  "event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
]);
const APPROVAL_EVENTS = [ERC20_APPROVAL, ...PERMIT2_EVENTS] as const;
const APPROVAL_TOPIC0S = APPROVAL_EVENTS.map((e) => toEventSelector(e));
const TRANSFER_TOPIC0 = toEventSelector(ERC20_TRANSFER);

const ACCOUNT_ABI = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
  "function entryPoint() view returns (address)",
  "function ownerCount() view returns (uint256)",
  "function implementation() view returns (address)",
]);

/** Canonical ERC-4337 EntryPoints (v0.6, v0.7, v0.8). */
const ENTRY_POINTS: Record<string, string> = {
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "EntryPoint v0.6",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "EntryPoint v0.7",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108": "EntryPoint v0.8",
};
/** Coinbase Smart Wallet v1 implementation (verified live behind a CBSW proxy on Base, 2026-11-07). */
const CBSW_IMPLEMENTATIONS = new Set(["0x000100abaad02f1cfc8bbe32bd5a564817339e72"]);

const MULTICALL_BATCH_BYTES = 24_000;
const DEFAULT_LOOKBACK_HOURS: Record<ChainId, number> = { 8453: 24, 4663: 8 };
const MAX_TOKENS = 80;
const MAX_DISCOVERED_SPENDERS = 40;

/** True when a multicall failure is a contract-level revert / empty return (vs an RPC or encoding failure). */
function isRevertLike(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    const name = (e as { name?: string }).name ?? "";
    if (/Reverted|ZeroData|AbiDecoding|PositionOutOfBounds|SliceOffsetOutOfBounds|InvalidAbiDecoding/i.test(name)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message || "RPC error").slice(0, 120);
}

function addrFromSlot(v: Hex | undefined | null): string | null {
  if (!v || v.length < 42) return null;
  const a = `0x${v.slice(-40)}`;
  return /^0x0{40}$/i.test(a) ? null : getAddress(a);
}

/**
 * Classify an address as an account: EOA, EIP-7702 delegated EOA, Safe (getThreshold/getOwners),
 * Coinbase Smart Wallet (ownerCount + CBSW implementation/EntryPoint) or a generic ERC-4337 account
 * (entryPoint() returns a canonical EntryPoint). Returns null for contracts that are not wallets.
 * Throws if the reads themselves fail (callers must not treat RPC errors as "not a wallet").
 */
export async function detectWalletAccount(chainId: ChainId, address: Address, code?: Hex | null): Promise<WalletAccountInfo | null> {
  const client = getPublicClientForChain(chainId);
  const bytecode = code === undefined ? await client.getCode({ address }) : code;
  const insp = inspectRawBytecode(bytecode ?? undefined);
  if (!bytecode || bytecode === "0x") return { kind: "eoa", label: "EOA" };
  if (insp.eip7702Delegate) return { kind: "eip7702", label: "EIP-7702 delegated EOA", delegate: insp.eip7702Delegate };

  const [res, implSlot] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: (["getThreshold", "getOwners", "VERSION", "entryPoint", "ownerCount", "implementation"] as const).map((functionName) => ({ address, abi: ACCOUNT_ABI, functionName })),
    }),
    client.getStorageAt({ address, slot: PROXY_STORAGE_SLOTS.eip1967Implementation }).catch(() => null),
  ]);
  // Fail closed: if the probes failed for transport reasons (not reverts), we cannot say "not a wallet".
  const rpcFailures = res.filter((r) => r.status === "failure" && !isRevertLike(r.error));
  if (rpcFailures.length === res.length) throw new Error(`Account detection failed: ${errorText(rpcFailures[0]?.error)}`);
  const [threshold, owners, version, entryPoint, ownerCount, implFn] = res;
  const impl = (implFn.status === "success" ? String(implFn.result) : null) ?? addrFromSlot(implSlot);

  if (threshold.status === "success" && owners.status === "success" && (threshold.result as bigint) > 0n && (owners.result as readonly string[]).length > 0) {
    const t = Number(threshold.result as bigint);
    const o = (owners.result as readonly string[]).map((x) => getAddress(x));
    return { kind: "safe", label: `Safe ${t}-of-${o.length} multisig`, safe: { threshold: t, owners: o.slice(0, 20), version: version.status === "success" ? String(version.result).slice(0, 16) : null }, implementation: impl };
  }
  const ep = entryPoint.status === "success" ? String(entryPoint.result).toLowerCase() : null;
  if (ownerCount.status === "success" && ((impl && CBSW_IMPLEMENTATIONS.has(impl.toLowerCase())) || (ep && ENTRY_POINTS[ep]))) {
    return { kind: "coinbase-smart-wallet", label: "Coinbase Smart Wallet", entryPoint: ep ? getAddress(ep) : null, implementation: impl };
  }
  if (ep && ENTRY_POINTS[ep]) {
    return { kind: "erc4337", label: `ERC-4337 smart account (${ENTRY_POINTS[ep]})`, entryPoint: getAddress(ep), implementation: impl };
  }
  return null;
}

function logCoverage(r: ChunkedLogsResult<unknown>): LogCoverage {
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

interface Spender {
  name: string;
  address: Address;
  known: boolean;
}

/** Accumulates (token, spender) pairs and reads only the not-yet-read ones per run(), all pinned to one block. */
class Matrix {
  readonly metas = new Map<string, TokenMeta>();
  readonly erc20Hits: { token: TokenMeta; spender: Spender; amount: bigint }[] = [];
  readonly p2Hits: { token: TokenMeta; spender: Spender; amount: bigint; expiration: number }[] = [];
  readonly holdings: { token: TokenMeta; balance: bigint }[] = [];
  readonly p2Spenders = new Set<string>();
  failedCalls = 0;
  erc20Count = 0;
  p2Count = 0;
  private seen = new Set<string>();
  private pendErc20: { token: TokenMeta; spender: Spender }[] = [];
  private pendP2: { token: TokenMeta; spender: Spender }[] = [];
  private pendBal: TokenMeta[] = [];

  constructor(
    private chainId: ChainId,
    private owner: Address,
    private block: bigint,
    private permit2Live: boolean
  ) {}

  addToken(m: TokenMeta) {
    const k = m.address.toLowerCase();
    if (this.metas.has(k)) return;
    this.metas.set(k, m);
    this.pendBal.push(m);
  }
  addErc20(m: TokenMeta, sp: Spender) {
    const k = `e:${m.address.toLowerCase()}:${sp.address.toLowerCase()}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.pendErc20.push({ token: m, spender: sp });
  }
  addP2(m: TokenMeta, sp: Spender) {
    if (!this.permit2Live) return;
    const k = `p:${m.address.toLowerCase()}:${sp.address.toLowerCase()}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.pendP2.push({ token: m, spender: sp });
  }

  async run() {
    const client = getPublicClientForChain(this.chainId);
    const [e, p, b] = [this.pendErc20, this.pendP2, this.pendBal];
    this.pendErc20 = [];
    this.pendP2 = [];
    this.pendBal = [];
    const opts = { allowFailure: true as const, blockNumber: this.block, batchSize: MULTICALL_BATCH_BYTES };
    const [balRes, allowRes, permitRes] = await Promise.all([
      b.length ? client.multicall({ ...opts, contracts: b.map((m) => ({ address: m.address as Address, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [this.owner] as const })) }) : Promise.resolve([]),
      e.length ? client.multicall({ ...opts, contracts: e.map((c) => ({ address: c.token.address as Address, abi: ERC20_ABI, functionName: "allowance" as const, args: [this.owner, c.spender.address] as const })) }) : Promise.resolve([]),
      p.length
        ? client.multicall({ ...opts, contracts: p.map((c) => ({ address: CONTRACTS.base.permit2, abi: PERMIT2_ABI, functionName: "allowance" as const, args: [this.owner, c.token.address as Address, c.spender.address] as const })) })
        : Promise.resolve([]),
    ]);
    this.erc20Count += e.length;
    this.p2Count += p.length;
    b.forEach((m, i) => {
      const r = balRes[i];
      if (!r || r.status !== "success") return void this.failedCalls++;
      if ((r.result as bigint) > 0n) this.holdings.push({ token: m, balance: r.result as bigint });
    });
    e.forEach((c, i) => {
      const r = allowRes[i];
      if (!r || r.status !== "success") return void this.failedCalls++;
      if ((r.result as bigint) > 0n) this.erc20Hits.push({ token: c.token, spender: c.spender, amount: r.result as bigint });
    });
    p.forEach((c, i) => {
      this.p2Spenders.add(c.spender.address.toLowerCase());
      const r = permitRes[i];
      if (!r || r.status !== "success") return void this.failedCalls++;
      const [amount, expiration] = r.result as readonly [bigint, number, number];
      if (amount > 0n) this.p2Hits.push({ token: c.token, spender: c.spender, amount, expiration: Number(expiration) });
    });
  }
}

export interface ScanWalletOptions {
  /** Pre-computed classification (scan.ts already detected it). */
  account?: WalletAccountInfo | null;
  /** Approval-log lookback. Default: Base 24h (address-filtered), Robinhood 8h wallet-wide + ~12 days per curated token. */
  lookbackHours?: number;
  /** Time budget for all log discovery. Default 5s. */
  logBudgetMs?: number;
}

/**
 * Live wallet exposure scan (EOAs, EIP-7702 EOAs, Safes, Coinbase Smart Wallets, ERC-4337 accounts):
 *  - native + ERC-20 balances over a curated, onchain-verified token list (+ discovered + caller tokens)
 *  - ERC-20 allowance() for every token × every verified spender (≈50 on Base), multicalled at one block
 *  - Permit2 allowance(owner, token, spender) for Permit2 routers (incl. the current Universal Router)
 *  - the wallet's own ERC-20 Approval + Permit2 Approval/Permit logs (chunked) → unknown spenders, unknown
 *    tokens (Robinhood: wallet-wide), and approvals granted overnight
 *  - an explicit coverage record (tokens × spenders, log window, partial flags) for honest UI copy
 */
export async function scanWallet(chainId: ChainId, address: Address, extraTokens: Address[] = [], opts: ScanWalletOptions = {}): Promise<WalletReport> {
  const client = getPublicClientForChain(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const [nativeBalance, account] = await Promise.all([
    client.getBalance({ address, blockNumber: latest.number }),
    opts.account !== undefined && opts.account !== null ? Promise.resolve(opts.account) : detectWalletAccount(chainId, address),
  ]);
  const notes: string[] = [];
  const permit2 = CONTRACTS.base.permit2; // same canonical address on both chains
  // Unreadable Permit2 code is UNKNOWN (coverage partial), never "Permit2 not deployed".
  let permit2Unknown = false;
  const permit2Live =
    chainId === 8453 ||
    (await client.getCode({ address: permit2 }).then(
      (c) => !!c && c !== "0x",
      () => {
        permit2Unknown = true;
        notes.push("Permit2 deployment check failed (RPC error): Permit2 allowances were not read.");
        return false;
      }
    ));
  /** Tokens whose decimals()/totalSupply() could not be read because the RPC failed (readTokenMeta threw). */
  let metaRpcFailures = 0;
  const metaOrCount = (t: Address) =>
    readTokenMeta(chainId, t).catch(() => {
      metaRpcFailures++;
      return null;
    });

  // ── 0 · curated matrix starts immediately, in parallel with log discovery ──
  const curatedSpenders = SPENDERS[chainId];
  const spenderMap = new Map<string, Spender>();
  for (const s of curatedSpenders) spenderMap.set(s.address.toLowerCase(), { name: s.name, address: s.address, known: true });
  const matrix = new Matrix(chainId, address, latest.number, permit2Live);
  const phase1Tokens = [...new Map([...TRACKED_TOKENS[chainId], ...extraTokens].map((t) => [t.toLowerCase(), t])).values()];
  const phase1 = (async () => {
    const metas = (await Promise.all(phase1Tokens.map((t) => metaOrCount(t)))).filter((m): m is TokenMeta => m !== null);
    for (const m of metas) {
      matrix.addToken(m);
      for (const sp of curatedSpenders) matrix.addErc20(m, spenderMap.get(sp.address.toLowerCase())!);
      for (const sp of PERMIT2_SPENDERS[chainId]) matrix.addP2(m, spenderMap.get(sp.address.toLowerCase())!);
    }
    await matrix.run();
  })();

  // ── 1 · log discovery (bounded by a shared time budget) ───────────────────
  const lookbackHours = Math.max(OVERNIGHT_HOURS, opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS[chainId]);
  const budget = opts.logBudgetMs ?? 5_000;
  const [overnightFrom, lookbackFrom] = await Promise.all([
    blockHoursAgo(chainId, client, latest.number, OVERNIGHT_HOURS),
    // ≤24h: the live 10k-block average is exact enough; longer windows may straddle a block-time change
    lookbackHours > 24
      ? blockAtTimestamp(chainId, client, Math.floor((Number(latest.timestamp) - lookbackHours * 3600) / 600) * 600, latest).catch(() => blockHoursAgo(chainId, client, latest.number, lookbackHours))
      : blockHoursAgo(chainId, client, latest.number, lookbackHours),
  ]);
  const ownerTopic = addressTopic(address);
  const curatedTokens = phase1Tokens;
  const walletWide = supportsTopicOnlyLogs(chainId);
  // ERC-20 Approval, Permit2 Approval, Permit2 Permit — topic0 OR'd, owner = topic1 in all three
  const approvalTopics = [APPROVAL_TOPIC0S, ownerTopic] as const;

  // a) address-filtered: curated + caller tokens + Permit2 over the lookback window (works on every provider)
  const rhHistoryFrom = latest.number > 9_999_999n ? latest.number - 9_999_999n : 0n;
  const filterAddrs = [...new Set([...curatedTokens, ...extraTokens, permit2].map((a) => a.toLowerCase()))].map((a) => getAddress(a));
  const addrFiltered =
    chainId === 4663
      ? // Robinhood: one address + ONE topic0 may span 10M blocks (~12 days); OR'd topic0s drop the cap to 100k,
        // so ERC-20 Approval is read per token and Permit2 Approval / Permit as two separate queries.
        Promise.all([
          ...filterAddrs
            .filter((a) => !isAddressEqual(a, permit2))
            .map((a) => getLogsChunked(chainId, { address: a, events: APPROVAL_EVENTS, topics: [APPROVAL_TOPIC0S[0], ownerTopic], fromBlock: rhHistoryFrom, toBlock: latest.number }, { timeBudgetMs: budget, maxLogs: 2_000 })),
          ...(permit2Live
            ? [1, 2].map((i) => getLogsChunked(chainId, { address: permit2, events: APPROVAL_EVENTS, topics: [APPROVAL_TOPIC0S[i], ownerTopic], fromBlock: rhHistoryFrom, toBlock: latest.number }, { timeBudgetMs: budget, maxLogs: 2_000 }))
            : []),
        ]).then((rs) => ({ rs, fullHistory: rs.filter((r) => r.complete).length }))
      : // Base: the overnight window first (queued first on the shared per-provider semaphore), the older
        // part of the lookback concurrently at lower priority — so overnight coverage survives a slow RPC.
        Promise.all([
          getLogsChunked(chainId, { address: filterAddrs, events: APPROVAL_EVENTS, topics: approvalTopics, fromBlock: overnightFrom, toBlock: latest.number }, { timeBudgetMs: budget + 1_000, maxLogs: 5_000 }),
          lookbackFrom < overnightFrom
            ? getLogsChunked(chainId, { address: filterAddrs, events: APPROVAL_EVENTS, topics: approvalTopics, fromBlock: lookbackFrom, toBlock: overnightFrom - 1n }, { timeBudgetMs: budget - 1_000, maxLogs: 5_000, concurrency: 2 })
            : Promise.resolve(null),
        ]).then(([a, b]) => ({ rs: b ? [a, b] : [a], fullHistory: 0 }));
  // b) wallet-wide (any token) where the provider allows topic-only filters
  const wideFrom = chainId === 4663 ? overnightFrom : lookbackFrom;
  const wideApprovals = walletWide
    ? getLogsChunked(chainId, { events: APPROVAL_EVENTS, topics: approvalTopics, fromBlock: wideFrom, toBlock: latest.number }, { timeBudgetMs: budget, maxLogs: 5_000 })
    : null;
  const wideTransfers = walletWide
    ? getLogsChunked(chainId, { event: ERC20_TRANSFER, topics: [TRANSFER_TOPIC0, null, ownerTopic], fromBlock: wideFrom, toBlock: latest.number }, { timeBudgetMs: budget, maxLogs: 3_000 })
    : null;

  const [addrRes, wideRes, transferRes] = await Promise.all([
    addrFiltered.catch((e) => {
      notes.push(`Approval-log discovery failed: ${e instanceof Error ? e.message.slice(0, 80) : "RPC error"}`);
      return { rs: [] as ChunkedLogsResult<unknown>[], fullHistory: 0 };
    }),
    wideApprovals?.catch(() => null) ?? Promise.resolve(null),
    wideTransfers?.catch(() => null) ?? Promise.resolve(null),
  ]);

  type ApprovalLog = { address: Address; blockNumber: bigint | null; eventName: string; args: { owner?: string; spender?: string; token?: string } };
  const approvalLogs: ApprovalLog[] = [];
  for (const r of addrRes.rs) approvalLogs.push(...(r.logs as unknown as ApprovalLog[]));
  if (wideRes) approvalLogs.push(...(wideRes.logs as unknown as ApprovalLog[]));

  // Overnight coverage: the primary window is the address-filtered query on Base, the wallet-wide one on Robinhood.
  const primary: ChunkedLogsResult<unknown> | null = chainId === 4663 ? wideRes : (addrRes.rs[0] ?? null);
  // A truncated read keeps only the newest logs: older overnight Approval events were dropped, so it is NOT covered.
  const overnightCovered = !!primary && primary.coveredFrom !== null && primary.coveredFrom <= overnightFrom && !primary.unsupported && !primary.truncated;
  if (primary?.truncated) notes.push(`Overnight Approval-log window truncated (more events than the per-scan cap): older approvals in the window were not read.`);
  const extended = chainId === 8453 ? (addrRes.rs[1] ?? null) : null;
  const extendedComplete = chainId === 8453 && overnightCovered && (!extended || extended.complete);
  if (extended && !extended.complete) notes.push(`Older part of the ${lookbackHours}h Approval-log lookback partially read: ${extended.note}`);

  // (token, spender) pairs from logs
  const erc20Pairs = new Map<string, { token: Address; spender: Address; lastBlock: bigint }>();
  const p2Pairs = new Map<string, { token: Address; spender: Address; lastBlock: bigint }>();
  const seenOvernight = new Set<string>();
  let newApprovalEvents = 0;
  for (const l of approvalLogs) {
    const bn = l.blockNumber ?? 0n;
    const isP2 = isAddressEqual(l.address, permit2) && (l.eventName === "Permit" || (l.eventName === "Approval" && typeof l.args.token === "string"));
    const token = isP2 ? l.args.token : l.address;
    const spender = l.args.spender;
    if (!token || !spender) continue;
    const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
    const map = isP2 ? p2Pairs : erc20Pairs;
    const prev = map.get(key);
    if (!prev || prev.lastBlock < bn) map.set(key, { token: getAddress(token), spender: getAddress(spender), lastBlock: bn });
    if (bn >= overnightFrom) {
      newApprovalEvents++;
      seenOvernight.add(`${isP2 ? "permit2" : "erc20"}:${key}`);
    }
  }
  const transferTokens = new Set<string>();
  if (transferRes) for (const l of transferRes.logs as unknown as { address: string }[]) transferTokens.add(l.address.toLowerCase());

  // ── 2 · discovered tokens / spenders → extra pairs (phase 2) ─────────────
  await phase1;
  const curatedSet = new Set(TRACKED_TOKENS[chainId].map((t) => t.toLowerCase()));
  const discoveredOrder = [...new Set([
    ...[...erc20Pairs.values()].map((p) => p.token.toLowerCase()),
    ...[...p2Pairs.values()].map((p) => p.token.toLowerCase()),
    ...transferTokens,
  ])].filter((t) => !matrix.metas.has(t) && !phase1Tokens.some((x) => x.toLowerCase() === t));
  const room = Math.max(0, MAX_TOKENS - matrix.metas.size);
  if (discoveredOrder.length > room) notes.push(`Token list capped at ${MAX_TOKENS} (${discoveredOrder.length - room} discovered token(s) not checked).`);
  const newMetas = (await Promise.all(discoveredOrder.slice(0, room).map((t) => metaOrCount(getAddress(t))))).filter((m): m is TokenMeta => m !== null);
  const unreadable = Math.min(room, discoveredOrder.length) - newMetas.length + (phase1Tokens.length - [...matrix.metas.keys()].length) - metaRpcFailures;
  if (unreadable > 0) notes.push(`${unreadable} token(s) did not answer decimals()/totalSupply() (not ERC-20) and were skipped.`);
  if (metaRpcFailures > 0) notes.push(`${metaRpcFailures} token(s) could not be read (RPC error) — their approvals are UNKNOWN; re-scan.`);

  const discoveredSpenders: Spender[] = [];
  for (const p of [...erc20Pairs.values(), ...p2Pairs.values()]) {
    const k = p.spender.toLowerCase();
    if (spenderMap.has(k) || isAddressEqual(p.spender, zeroAddress) || discoveredSpenders.length >= MAX_DISCOVERED_SPENDERS) continue;
    const sp = { name: SPENDER_LABELS[k] ?? "Unlabeled spender (from Approval logs)", address: p.spender, known: !!SPENDER_LABELS[k] };
    spenderMap.set(k, sp);
    discoveredSpenders.push(sp);
  }
  for (const m of newMetas) {
    matrix.addToken(m);
    for (const sp of curatedSpenders) matrix.addErc20(m, spenderMap.get(sp.address.toLowerCase())!);
    for (const sp of PERMIT2_SPENDERS[chainId]) matrix.addP2(m, spenderMap.get(sp.address.toLowerCase())!);
  }
  for (const m of matrix.metas.values()) if (curatedSet.has(m.address.toLowerCase())) for (const sp of discoveredSpenders) matrix.addErc20(m, sp);
  for (const p of erc20Pairs.values()) {
    const m = matrix.metas.get(p.token.toLowerCase());
    const sp = spenderMap.get(p.spender.toLowerCase());
    if (m && sp) matrix.addErc20(m, sp);
  }
  for (const p of p2Pairs.values()) {
    const m = matrix.metas.get(p.token.toLowerCase());
    const sp = spenderMap.get(p.spender.toLowerCase());
    if (m && sp) matrix.addP2(m, sp);
  }
  await matrix.run();

  // ── 3 · results → approvals ───────────────────────────────────────────────
  const nowSec = Number(latest.timestamp);
  const approvals: ApprovalExposure[] = [];
  for (const { token: m, spender: sp, amount } of matrix.erc20Hits) {
    const k = `${m.address.toLowerCase()}:${sp.address.toLowerCase()}`;
    approvals.push({
      token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: sp.address, spenderName: sp.name,
      kind: "erc20", amount: amount.toString(), unlimited: isUnlimited(amount),
      discoveredOvernight: seenOvernight.has(`erc20:${k}`),
      spenderKnown: sp.known,
      source: erc20Pairs.has(k) && !sp.known ? "approval-log" : "matrix",
    });
  }
  for (const { token: m, spender: sp, amount, expiration } of matrix.p2Hits) {
    if (expiration <= nowSec) continue;
    const k = `${m.address.toLowerCase()}:${sp.address.toLowerCase()}`;
    approvals.push({
      token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: sp.address, spenderName: `${sp.name} via Permit2`,
      kind: "permit2", amount: amount.toString(), unlimited: isUnlimited(amount), expiration,
      discoveredOvernight: seenOvernight.has(`permit2:${k}`),
      spenderKnown: sp.known,
      source: p2Pairs.has(k) && !sp.known ? "approval-log" : "matrix",
    });
  }
  const metas = [...matrix.metas.values()];
  const spenders = [...spenderMap.values()];
  const failedCalls = matrix.failedCalls + metaRpcFailures;

  // ── 4 · coverage (stated honestly in UI + brief) ──────────────────────────
  const totalCalls = matrix.erc20Count + matrix.p2Count + metas.length;
  const multicallDegraded = totalCalls > 0 && failedCalls / totalCalls > 0.05;
  if (multicallDegraded) notes.push(`${failedCalls} of ${totalCalls} allowance/balance reads failed — results incomplete.`);
  if (!walletWide && chainId === 8453) notes.push("Base public RPC requires an address filter for logs, so Approval-log discovery covers the curated tokens + Permit2 (set BASE_LOGS_RPC_URL for wallet-wide discovery).");
  if (primary && !primary.complete) notes.push(primary.note);
  if (chainId === 4663 && addrRes.rs.length && addrRes.fullHistory < addrRes.rs.length) {
    const bad = addrRes.rs.find((r) => !r.complete);
    notes.push(`${addrRes.rs.length - addrRes.fullHistory} of ${addrRes.rs.length} per-token Approval-history reads incomplete${bad ? ` (${bad.note})` : ""}.`);
  }
  const coverage: ApprovalCoverage = {
    tokensChecked: metas.length,
    curatedTokens: metas.filter((m) => curatedSet.has(m.address.toLowerCase())).length,
    discoveredTokens: metas.filter((m) => !curatedSet.has(m.address.toLowerCase())).length,
    spendersChecked: spenders.length,
    curatedSpenders: curatedSpenders.length,
    discoveredSpenders: discoveredSpenders.length,
    permit2SpendersChecked: matrix.p2Spenders.size,
    erc20PairsChecked: matrix.erc20Count,
    permit2PairsChecked: matrix.p2Count,
    failedCalls,
    logLookbackHours: chainId === 4663 ? OVERNIGHT_HOURS : extendedComplete ? lookbackHours : OVERNIGHT_HOURS,
    logCoverage: primary ? logCoverage(primary) : null,
    walletWideLogDiscovery: walletWide && !!wideRes && !wideRes.unsupported,
    deepHistoryReads: addrRes.fullHistory,
    partial: multicallDegraded || !overnightCovered || metaRpcFailures > 0 || permit2Unknown,
    notes,
  };

  const overnightApprovalScan: WalletReport["overnightApprovalScan"] = overnightCovered
    ? {
        available: true,
        hours: OVERNIGHT_HOURS,
        newApprovals: newApprovalEvents,
        note: `${chainId === 4663 ? "Wallet-wide" : `${filterAddrs.length - 1} curated tokens + Permit2`} Approval/Permit logs read from block #${overnightFrom} (${primary?.chunks ?? 0} chunk${primary?.chunks === 1 ? "" : "s"} via ${primary?.provider ?? "rpc"}).`,
      }
    : { available: false, hours: OVERNIGHT_HOURS, newApprovals: 0, note: primary ? `Overnight Approval-log window not fully read: ${primary.note}` : "Overnight Approval-log scan failed; the curated token × spender allowance matrix still applies." };

  return {
    chainId,
    address,
    nativeBalance: nativeBalance.toString(),
    eip7702Delegate: account?.kind === "eip7702" ? (account.delegate ?? null) : null,
    holdings: matrix.holdings.map(({ token: m, balance }) => ({ token: m.address, symbol: m.symbol, decimals: m.decimals, balance: balance.toString() })),
    approvals,
    spendersChecked: spenders.length,
    overnightApprovalScan,
    account: account ?? { kind: "smart-wallet", label: "Contract wallet" },
    coverage,
  };
}
