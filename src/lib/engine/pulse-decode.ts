import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import type { EventKind, PulseEvent } from "./pulse-types";

/**
 * Pure classifier for the Sentinel Watch feed: raw eth_getLogs entries → PulseEvent[]. Imports only viem, so the
 * node:test suite can load it directly. Rules:
 *  - removed / pending logs are skipped; the Permit2 `owner` is never emitted;
 *  - Permit2 Approval / Permit → GRANT | MAX (amount ≥ 2^128) | REVOKE (amount 0); Lockdown → REVOKE;
 *  - watched $VIBES / OFT / Vibestarter logs collapse to ONE contact per (chain, tx), highest priority kind,
 *    anchored at the lowest logIndex of that tx;
 *  - labels come only from the caller's verified per-chain maps, otherwise a short address (never a guess).
 */

export type { EventKind } from "./pulse-types";

export interface RpcLogLike {
  address: string;
  topics: readonly (string | null | undefined)[];
  data: string;
  blockNumber: bigint | string | number | null | undefined;
  transactionHash: string | null | undefined;
  logIndex: number | string | null | undefined;
  removed?: boolean;
}

export interface DecodeCtx {
  chainId: 8453 | 4663;
  /** All keys/values below are lowercase addresses. */
  permit2: string;
  contact: Set<string>;
  vibestarter: Set<string>;
  symbols: Record<string, string>;
  spenders: Record<string, string>;
  swapLabel: "AERODROME SWAP" | "UNISWAP V3 SWAP";
}

const PERMIT2_ABI = parseAbi([
  "event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)",
  "event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)",
  "event Lockdown(address indexed owner, address token, address spender)",
]);

const sel = (s: string) => toEventSelector(s).toLowerCase();

const CONTACT_KIND: Record<string, EventKind | "SKIP"> = {
  [sel("Transfer(address,address,uint256)")]: "VIBES_TRANSFER",
  [sel("Approval(address,address,uint256)")]: "VIBES_APPROVAL",
  // Aerodrome (Solidly) pool + Uniswap v3 pool
  [sel("Swap(address,address,uint256,uint256,uint256,uint256)")]: "VIBES_SWAP",
  [sel("Swap(address,address,int256,int256,uint160,uint128,int24)")]: "VIBES_SWAP",
  [sel("Mint(address,uint256,uint256)")]: "VIBES_LP",
  [sel("Burn(address,address,uint256,uint256)")]: "VIBES_LP",
  [sel("Mint(address,address,int24,int24,uint128,uint256,uint256)")]: "VIBES_LP",
  [sel("Burn(address,int24,int24,uint128,uint256,uint256)")]: "VIBES_LP",
  [sel("Collect(address,address,int24,int24,uint128,uint128)")]: "VIBES_LP",
  [sel("Sync(uint256,uint256)")]: "SKIP",
  // LayerZero OFT v2
  [sel("OFTSent(bytes32,uint32,address,uint256,uint256)")]: "OFT_SENT",
  [sel("OFTReceived(bytes32,uint32,address,uint256)")]: "OFT_RECEIVED",
};

const PRIORITY: Record<EventKind, number> = {
  OFT_SENT: 7,
  OFT_RECEIVED: 7,
  VIBES_SWAP: 6,
  VIBES_LP: 5,
  VIBESTARTER: 4,
  VIBES_TRANSFER: 3,
  VIBES_APPROVAL: 2,
  VIBES_LOG: 1,
  P2_GRANT: 0,
  P2_MAX: 0,
  P2_REVOKE: 0,
};

const MAX_THRESHOLD = 1n << 128n;

export function contactLabel(kind: EventKind, swapLabel: DecodeCtx["swapLabel"]): string {
  switch (kind) {
    case "VIBES_SWAP":
      return swapLabel;
    case "VIBES_LP":
      return "LP MINT/BURN";
    case "VIBES_TRANSFER":
      return "VIBES TRANSFER";
    case "VIBES_APPROVAL":
      return "VIBES APPROVAL";
    case "OFT_SENT":
      return "OFT SENT";
    case "OFT_RECEIVED":
      return "OFT RECEIVED";
    case "VIBESTARTER":
      return "VIBESTARTER ESCROW EVENT";
    case "VIBES_LOG":
      return "$VIBES LOG";
    default:
      return kind;
  }
}

export function shortHex(a: string | null | undefined): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function toBlock(v: RpcLogLike["blockNumber"]): string | null {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v).toString();
  } catch {
    return null;
  }
}

function toIndex(v: RpcLogLike["logIndex"]): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(BigInt(v));
  return Number.isFinite(n) ? n : null;
}

interface Norm {
  log: RpcLogLike;
  address: string;
  block: string;
  blockBig: bigint;
  tx: string;
  logIndex: number;
}

export function classifyLogs(logs: readonly RpcLogLike[], ctx: DecodeCtx): PulseEvent[] {
  const out: PulseEvent[] = [];
  const contacts = new Map<string, { ev: PulseEvent; pri: number }>();

  for (const log of logs) {
    if (log.removed) continue;
    const block = toBlock(log.blockNumber);
    const logIndex = toIndex(log.logIndex);
    const tx = log.transactionHash ? log.transactionHash.toLowerCase() : null;
    if (block === null || logIndex === null || !tx) continue;
    const n: Norm = { log, address: log.address.toLowerCase(), block, blockBig: BigInt(block), tx, logIndex };

    if (n.address === ctx.permit2) {
      const ev = decodePermit2(n, ctx);
      if (ev) out.push(ev);
      continue;
    }
    if (!ctx.contact.has(n.address)) continue;

    let kind: EventKind;
    if (ctx.vibestarter.has(n.address)) kind = "VIBESTARTER";
    else {
      const t0 = (log.topics[0] ?? "").toLowerCase();
      const k = CONTACT_KIND[t0];
      if (k === "SKIP") continue;
      kind = k ?? "VIBES_LOG";
    }
    const key = `${ctx.chainId}:${tx}`;
    const pri = PRIORITY[kind];
    const prev = contacts.get(key);
    const symbol = ctx.symbols[n.address] ?? null;
    if (!prev) {
      contacts.set(key, {
        pri,
        ev: {
          id: `${ctx.chainId}:${tx}:${logIndex}`,
          chainId: ctx.chainId,
          block,
          tx,
          logIndex,
          kind,
          contact: true,
          token: n.address,
          symbol,
          spender: null,
          spenderLabel: null,
          summary: contactLabel(kind, ctx.swapLabel),
        },
      });
    } else {
      const ev = prev.ev;
      if (pri > prev.pri) {
        prev.pri = pri;
        ev.kind = kind;
        ev.summary = contactLabel(kind, ctx.swapLabel);
        ev.token = n.address;
        ev.symbol = symbol;
      }
      if (logIndex < ev.logIndex) {
        ev.logIndex = logIndex;
        ev.id = `${ctx.chainId}:${tx}:${logIndex}`;
      }
    }
  }

  for (const { ev } of contacts.values()) out.push(ev);
  out.sort((a, b) => {
    const ab = BigInt(a.block);
    const bb = BigInt(b.block);
    if (ab !== bb) return ab < bb ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return out;
}

function decodePermit2(n: Norm, ctx: DecodeCtx): PulseEvent | null {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: PERMIT2_ABI,
      data: n.log.data as `0x${string}`,
      topics: n.log.topics.filter((t): t is string => typeof t === "string") as [`0x${string}`, ...`0x${string}`[]],
      strict: false,
    }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null;
  }
  const args = decoded.args ?? {};
  const token = typeof args.token === "string" ? args.token.toLowerCase() : null;
  const spender = typeof args.spender === "string" ? args.spender.toLowerCase() : null;
  let kind: EventKind;
  if (decoded.eventName === "Lockdown") kind = "P2_REVOKE";
  else if (decoded.eventName === "Approval" || decoded.eventName === "Permit") {
    const amount = typeof args.amount === "bigint" ? args.amount : null;
    if (amount === null) return null;
    kind = amount === 0n ? "P2_REVOKE" : amount >= MAX_THRESHOLD ? "P2_MAX" : "P2_GRANT";
  } else return null;

  const symbol = token ? (ctx.symbols[token] ?? null) : null;
  const spenderLabel = spender ? (ctx.spenders[spender] ?? null) : null;
  const word = kind === "P2_MAX" ? "MAX" : kind === "P2_REVOKE" ? "REVOKE" : "GRANT";
  return {
    id: `${ctx.chainId}:${n.tx}:${n.logIndex}`,
    chainId: ctx.chainId,
    block: n.block,
    tx: n.tx,
    logIndex: n.logIndex,
    kind,
    contact: false,
    token,
    symbol,
    spender,
    spenderLabel,
    summary: `PERMIT2 ${word} ${symbol ?? shortHex(token)} → ${spenderLabel ?? shortHex(spender)}`,
  };
}

/** Robinhood Chain (Arbitrum Nitro) gas-speed limit: eth_feeHistory.gasUsedRatio is measured against this. */
export const RH_GAS_PER_SEC = 14_000_000;

/**
 * Robinhood Chain per-block gas from eth_feeHistory. On Nitro, gasUsedRatio[i] is NOT gasUsed/gasLimit (the gas
 * limit is 2^50): it is the running gasUsed total of every block sharing block i's timestamp-second ÷ 14,000,000,
 * and blocks in the window's first partial second read 1.0. Differencing the running sum recovers each block's own
 * gasUsed; the result is expressed as gasUsed ÷ (14M · cadence / 1000), i.e. against the block's share of the
 * per-second limit, so √ratio drives the bar like Base's gasUsed/gasLimit. null = unknown (window start or a
 * saturated reading) — drawn as a neutral stub, never guessed. Not capped: barLen() caps the drawn length, and the
 * tooltip can show the real gasUsed. A new second whose first block alone exceeds the previous second's whole
 * total is indistinguishable from a continuation without timestamps (it under-reads); this is rare at ~10 blk/s.
 */
export function rhPerBlockGas(ratios: readonly number[], cadenceMs: number): (number | null)[] {
  const c = cadenceMs > 0 ? cadenceMs : 104;
  return ratios.map((raw, i) => {
    const r = Number(raw);
    const p = i > 0 ? Number(ratios[i - 1]) : NaN;
    if (i === 0 || !Number.isFinite(r) || !Number.isFinite(p) || r >= 1 || p >= 1) return null;
    const own = r >= p ? r - p : r;
    return Math.round(Math.max(0, (own * 1000) / c) * 100_000) / 100_000;
  });
}
