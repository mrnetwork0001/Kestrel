import { type Address, getAddress, isAddress, type PublicClient } from "viem";
import { ERC20_ABI } from "@/lib/abis";
import { getPublicClientForChain } from "@/lib/rpc";
import { isRpcFailure } from "./call-errors";
import type { BlockRef, ChainId, TokenMeta } from "./types";

/**
 * @deprecated Lenient: ANY unsupported chain id silently becomes Base (8453). Only for UI query params where a
 * fallback view is acceptable. APIs, the guard and MCP must use `parseChainId` / `requireChainId` and reject
 * unsupported chains (HTTP 400 / JSON-RPC -32602) instead of answering about the wrong chain.
 */
export function normalizeChainId(input: unknown): ChainId {
  const n = Number(input);
  return n === 4663 ? 4663 : 8453;
}

export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = [8453, 4663];
export const SUPPORTED_CHAINS_TEXT = "8453 (Base) or 4663 (Robinhood Chain)";

/**
 * Strict chain id. Absent (undefined / null / "") → `fallback` (Base by default). 8453 / 4663 as a number, a
 * decimal string or a 0x hex string are accepted. Anything else (other chains, garbage, floats) → null.
 */
export function parseChainId(input: unknown, fallback: ChainId | null = 8453): ChainId | null {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input !== "number" && typeof input !== "string") return null;
  const s = String(input).trim();
  if (!/^(\d{1,10}|0x[0-9a-fA-F]{1,8})$/.test(s)) return null;
  const n = Number(s);
  return n === 8453 ? 8453 : n === 4663 ? 4663 : null;
}

/** Typed error for an unsupported chain id — map to HTTP 400 (or JSON-RPC -32602). */
export class UnsupportedChainError extends Error {
  readonly status = 400;
  readonly supportedChainIds = SUPPORTED_CHAIN_IDS;
  constructor(readonly input: unknown) {
    super(`Unsupported chainId ${JSON.stringify(String(input)).slice(0, 40)}. Kestrel reads ${SUPPORTED_CHAINS_TEXT} only.`);
    this.name = "UnsupportedChainError";
  }
}

/** Strict chain id or throw `UnsupportedChainError`. Absent → Base. */
export function requireChainId(input: unknown): ChainId {
  const c = parseChainId(input);
  if (c === null) throw new UnsupportedChainError(input);
  return c;
}

export function parseAddress(input: unknown): Address | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!isAddress(s, { strict: false })) return null;
  return getAddress(s.toLowerCase());
}

export async function latestBlockRef(chainId: ChainId): Promise<BlockRef> {
  const client = getPublicClientForChain(chainId);
  const block = await client.getBlock({ blockTag: "latest" });
  return { chainId, number: block.number.toString(), timestamp: Number(block.timestamp) };
}

const avgBlockTimeCache = new Map<number, { value: number; at: number }>();

/** Average block time measured live from the chain (latest vs latest − 10,000), cached 10 min. */
export async function avgBlockTimeSeconds(chainId: ChainId, client: PublicClient): Promise<number> {
  const hit = avgBlockTimeCache.get(chainId);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  const latest = await client.getBlock({ blockTag: "latest" });
  const SAMPLE = 10_000n;
  const past = await client.getBlock({ blockNumber: latest.number - SAMPLE });
  const value = Math.max(0.01, Number(latest.timestamp - past.timestamp) / Number(SAMPLE));
  avgBlockTimeCache.set(chainId, { value, at: Date.now() });
  return value;
}

/** Estimate the block number `hours` ago from the live average block time. */
export async function blockHoursAgo(chainId: ChainId, client: PublicClient, latest: bigint, hours: number): Promise<bigint> {
  const bt = await avgBlockTimeSeconds(chainId, client);
  const back = BigInt(Math.round((hours * 3600) / bt));
  return latest > back ? latest - back : 0n;
}

const tsBlockCache = new Map<string, { value: bigint; at: number }>();

/**
 * Latest block with timestamp <= `ts`, found by interpolation search on live block headers (no archive
 * state needed). Correct across block-time changes (Base moved from 2 s to 200 ms blocks on 2026-11-05),
 * unlike a single average-block-time estimate. Resolution: within ~`toleranceSec` seconds. Cached 10 min.
 */
export async function blockAtTimestamp(chainId: ChainId, client: PublicClient, ts: number, latest?: { number: bigint; timestamp: bigint }, toleranceSec = 120): Promise<bigint> {
  const key = `${chainId}:${Math.floor(ts / 60)}`;
  const hit = tsBlockCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  const head = latest ?? (await client.getBlock({ blockTag: "latest" }));
  const target = BigInt(Math.floor(ts));
  if (target >= head.timestamp) return head.number;
  let hiN = head.number;
  let hiT = head.timestamp;
  const bt = await avgBlockTimeSeconds(chainId, client);
  // Seed below the target: the live average block time can be far off for older history (Base moved from 2 s to
  // 200 ms blocks), so aim 1.5× further back than the estimate. Never seed at genesis unless the chain is that young.
  const estBack = BigInt(Math.ceil((Number(head.timestamp - target) / bt) * 1.5)) + 1n;
  let guess = head.number > estBack ? head.number - estBack : 1n;
  let loN: bigint | null = null;
  let loT = 0n;
  let prevSpan: bigint | null = null;
  // Safeguarded interpolation search: interpolate inside [lo, hi], but bisect whenever the previous step failed to
  // halve the bracket (a skewed bracket — e.g. a genesis block with timestamp 0 — otherwise creeps from one side).
  for (let i = 0; i < 48; i++) {
    const b = await client.getBlock({ blockNumber: guess });
    if (b.timestamp > target) {
      hiN = b.number;
      hiT = b.timestamp;
    } else {
      loN = b.number;
      loT = b.timestamp;
      if (target - b.timestamp <= BigInt(toleranceSec)) break;
    }
    if (loN === null) {
      // no lower bound yet: extrapolate further back (overshoot 50% so the next probe lands below target)
      if (hiN <= 1n) {
        if (hiN === 0n) break;
        guess = 0n;
        continue;
      }
      const back = BigInt(Math.ceil((Number(hiT - target) / bt) * 1.5)) + 1n;
      guess = hiN > back ? hiN - back : hiN > 1n ? 1n : 0n;
      if (guess === hiN) guess = hiN - 1n;
      continue;
    }
    const span = hiN - loN;
    if (span <= 1n) break;
    const bisect = prevSpan !== null && span * 2n > prevSpan;
    prevSpan = span;
    const spanT = hiT - loT;
    const next = !bisect && spanT > 0n ? loN + (span * (target - loT)) / spanT : loN + span / 2n;
    guess = next <= loN ? loN + 1n : next >= hiN ? hiN - 1n : next;
  }
  if (loN === null) throw new Error(`blockAtTimestamp: no block at or before ${ts} found`);
  const value = loN;
  tsBlockCache.set(key, { value, at: Date.now() });
  return value;
}

const tokenCache = new Map<string, { meta: TokenMeta; at: number }>();

/** Thrown by readTokenMeta when decimals()/totalSupply() could not be read because the RPC failed. */
export class TokenMetaRpcError extends Error {
  constructor(address: string) {
    super(`decimals()/totalSupply() read failed for ${address} (RPC error, not a contract answer)`);
    this.name = "TokenMetaRpcError";
  }
}

/**
 * ERC-20 metadata via one multicall. Returns null only when the contract ANSWERED that it is not an ERC-20
 * (revert / empty data). Throws TokenMetaRpcError when the RPC failed, so callers report UNKNOWN, never "contract".
 */
export async function readTokenMeta(chainId: ChainId, address: Address): Promise<TokenMeta | null> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.meta;
  const client = getPublicClientForChain(chainId);
  const [name, symbol, decimals, totalSupply] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address, abi: ERC20_ABI, functionName: "name" },
      { address, abi: ERC20_ABI, functionName: "symbol" },
      { address, abi: ERC20_ABI, functionName: "decimals" },
      { address, abi: ERC20_ABI, functionName: "totalSupply" },
    ],
  });
  if (isRpcFailure(decimals) || isRpcFailure(totalSupply)) throw new TokenMetaRpcError(address);
  if (decimals.status !== "success" || totalSupply.status !== "success") return null;
  const meta: TokenMeta = {
    address,
    chainId,
    name: name.status === "success" ? String(name.result).slice(0, 64) : "Unknown",
    symbol: symbol.status === "success" ? String(symbol.result).slice(0, 24) : "???",
    decimals: Number(decimals.result),
    totalSupply: totalSupply.result.toString(),
  };
  tokenCache.set(key, { meta, at: Date.now() });
  return meta;
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { shortMessage?: string; message?: string };
    return (anyE.shortMessage || anyE.message || "Unknown error").slice(0, 200);
  }
  return String(e).slice(0, 200);
}
