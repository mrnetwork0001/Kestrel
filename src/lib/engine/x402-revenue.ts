import { type Address, formatUnits, type Hex, parseAbiItem } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { kvDel, kvGetJson, kvSet, kvSetJson, kvSMembers } from "@/lib/kv";
import { baseLogsClient, basePublicClient } from "@/lib/rpc";
import { NETWORK_V2, x402Config } from "@/lib/x402";
import { AUTHORIZATION_USED_TOPIC } from "@/lib/x402-facilitator";

/**
 * Independent onchain proof of x402 revenue: every Base USDC `Transfer` into X402_RECEIVER_ADDRESS.
 *  - publicnode caps eth_getLogs at toBlock - fromBlock <= 50,000 and mainnet.base.org refuses eth_getLogs,
 *    so this uses baseLogsClient (publicnode first) in 50k-block windows.
 *  - Base runs 200 ms blocks since 2026-11-05 (432k blocks/day), so a full rescan from X402_LEDGER_FROM_BLOCK
 *    would grow without bound. Instead a cursor + running totals are persisted in KV and each call scans only
 *    new blocks (at most MAX_WINDOWS_PER_CALL windows; `catchingUp: true` until the cursor reaches the head).
 *  - Without X402_LEDGER_FROM_BLOCK the scan starts ~24 h before the first observation (labelled `auto-24h`).
 */
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SPAN = 50_000n; // [from, from + SPAN - 1] keeps toBlock - fromBlock < 50,000
const CONCURRENCY = 4;
const MAX_WINDOWS_PER_CALL = 24; // 1.2M blocks ~ 2.8 days at 200 ms
const CONFIRMATIONS = 20n; // stay a few seconds behind the head so fallback RPCs agree on the logs
const AUTO_LOOKBACK = 432_000n; // ~24 h of Base blocks
const RECENT_KEEP = 20;
const RECENT_LABELLED = 8;

interface RecentRaw {
  tx: Hex;
  block: string;
  payer: Address;
  amountAtomic: string;
}
interface RevenueState {
  v: 1;
  fromBlock: string;
  scannedTo: string;
  transfers: number;
  totalAtomic: string;
  payers: string[];
  recent: RecentRaw[]; // newest first
  updatedAt: string;
}

export interface RevenueRow extends RecentRaw {
  /** USDC AuthorizationUsed in the same tx = EIP-3009 settlement (how x402 "exact" settles). null = receipt unavailable. */
  viaEip3009: boolean | null;
  /** tx sender; for x402 settlements this is the facilitator EOA that paid gas. */
  submittedBy: Address | null;
  explorer: string;
}

export type RevenueReport =
  | { configured: false; reason: string; asset: Address; network: typeof NETWORK_V2 }
  | {
      configured: true;
      receiver: Address;
      asset: Address;
      network: typeof NETWORK_V2;
      priceAtomic: string;
      fromBlock: string;
      fromBlockSource: "env" | "auto-24h";
      scannedTo: string;
      headBlock: string;
      catchingUp: boolean;
      transfers: number;
      totalAtomic: string;
      totalUsdc: string;
      uniquePayers: number;
      recent: RevenueRow[];
      explorer: string;
      ledger: { settlementsRecorded: number | null };
      scanError: string | null;
      updatedAt: string;
    };

function envFromBlock(): bigint | null {
  const raw = process.env.X402_LEDGER_FROM_BLOCK?.trim();
  return raw && /^\d{1,12}$/.test(raw) ? BigInt(raw) : null;
}

async function fetchWindow(receiver: Address, from: bigint, to: bigint) {
  return baseLogsClient.getLogs({ address: CONTRACTS.base.usdc, event: TRANSFER, args: { to: receiver }, fromBlock: from, toBlock: to });
}

/** Scan [start, end] in 50k windows, CONCURRENCY at a time; stops at the first failing round and reports how far it got. */
async function scanRange(receiver: Address, start: bigint, end: bigint) {
  const windows: [bigint, bigint][] = [];
  for (let f = start; f <= end && windows.length < MAX_WINDOWS_PER_CALL; f += SPAN) windows.push([f, f + SPAN - 1n > end ? end : f + SPAN - 1n]);
  const logs: Awaited<ReturnType<typeof fetchWindow>> = [];
  let scannedTo = start - 1n;
  let error: string | null = null;
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    const round = windows.slice(i, i + CONCURRENCY);
    try {
      const res = await Promise.all(round.map(([f, t]) => fetchWindow(receiver, f, t)));
      logs.push(...res.flat());
      scannedTo = round[round.length - 1][1];
    } catch (e) {
      error = (e instanceof Error ? (e as { shortMessage?: string }).shortMessage || e.message : String(e)).slice(0, 160);
      break;
    }
  }
  return { logs, scannedTo, error };
}

export async function x402RevenueReport(): Promise<RevenueReport> {
  const cfg = x402Config();
  if (!cfg.receiver) {
    return { configured: false, reason: "X402_RECEIVER_ADDRESS is not set on this deployment, so it cannot receive x402 payments.", asset: cfg.asset, network: NETWORK_V2 };
  }
  const receiver = cfg.receiver;
  const head = await baseLogsClient.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : head;
  const fromEnv = envFromBlock();
  const stateKey = `x402:revenue:v1:${receiver.toLowerCase()}:${fromEnv ?? "auto"}`;
  const lockKey = `${stateKey}:lock`;

  let state = await kvGetJson<RevenueState>(stateKey);
  if (state && state.v !== 1) state = null;
  let scanError: string | null = null;

  const gotLock = await kvSet(lockKey, "1", { nx: true, ex: 55 }).catch(() => false);
  if (gotLock || !state) {
    try {
      const fromBlock = state ? BigInt(state.fromBlock) : (fromEnv ?? (safeHead > AUTO_LOOKBACK ? safeHead - AUTO_LOOKBACK : 0n));
      const start = state ? BigInt(state.scannedTo) + 1n : fromBlock > safeHead ? safeHead : fromBlock;
      const base: RevenueState = state ?? { v: 1, fromBlock: fromBlock.toString(), scannedTo: (start - 1n).toString(), transfers: 0, totalAtomic: "0", payers: [], recent: [], updatedAt: new Date().toISOString() };
      if (start <= safeHead) {
        const { logs, scannedTo, error } = await scanRange(receiver, start, safeHead);
        scanError = error;
        let total = BigInt(base.totalAtomic);
        const payers = new Set(base.payers);
        const fresh: RecentRaw[] = [];
        for (const l of logs) {
          const value = l.args.value ?? 0n;
          total += value;
          if (l.args.from) payers.add(l.args.from.toLowerCase());
          fresh.push({ tx: l.transactionHash, block: l.blockNumber.toString(), payer: (l.args.from ?? "0x0000000000000000000000000000000000000000") as Address, amountAtomic: value.toString() });
        }
        state = {
          v: 1,
          fromBlock: base.fromBlock,
          scannedTo: scannedTo.toString(),
          transfers: base.transfers + logs.length,
          totalAtomic: total.toString(),
          payers: [...payers],
          recent: [...fresh.reverse(), ...base.recent].slice(0, RECENT_KEEP),
          updatedAt: new Date().toISOString(),
        };
        // Persist only when we own the lock (prevents two concurrent scanners double-counting a range).
        if (gotLock && scannedTo >= start) await kvSetJson(stateKey, state).catch(() => undefined);
      } else {
        state = base;
      }
    } finally {
      if (gotLock) await kvDel(lockKey).catch(() => 0);
    }
  }
  const s = state as RevenueState;

  // Label the newest rows from their receipts: an x402 "exact" settlement emits USDC AuthorizationUsed in the same tx.
  const labelled = s.recent.slice(0, RECENT_LABELLED);
  const receipts = await Promise.all(labelled.map((r) => basePublicClient.getTransactionReceipt({ hash: r.tx }).catch(() => null)));
  const usdc = CONTRACTS.base.usdc.toLowerCase();
  const recent: RevenueRow[] = labelled.map((r, i) => {
    const rc = receipts[i];
    return {
      ...r,
      viaEip3009: rc ? rc.logs.some((x) => x.address.toLowerCase() === usdc && x.topics[0] === AUTHORIZATION_USED_TOPIC) : null,
      submittedBy: rc ? rc.from : null,
      explorer: `https://basescan.org/tx/${r.tx}`,
    };
  });
  const ledgerTxs = await kvSMembers("x402:txs").catch(() => null);

  return {
    configured: true,
    receiver,
    asset: cfg.asset,
    network: NETWORK_V2,
    priceAtomic: cfg.priceAtomic,
    fromBlock: s.fromBlock,
    fromBlockSource: fromEnv !== null ? "env" : "auto-24h",
    scannedTo: s.scannedTo,
    headBlock: head.toString(),
    catchingUp: BigInt(s.scannedTo) < safeHead,
    transfers: s.transfers,
    totalAtomic: s.totalAtomic,
    totalUsdc: formatUnits(BigInt(s.totalAtomic), 6),
    uniquePayers: s.payers.length,
    recent,
    explorer: `https://basescan.org/token/${cfg.asset}?a=${receiver}`,
    ledger: { settlementsRecorded: ledgerTxs ? ledgerTxs.length : null },
    scanError,
    updatedAt: s.updatedAt,
  };
}
