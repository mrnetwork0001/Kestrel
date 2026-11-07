import { type Address, getAddress, isAddress, type PublicClient } from "viem";
import { ERC20_ABI } from "@/lib/abis";
import { getPublicClientForChain } from "@/lib/rpc";
import type { BlockRef, ChainId, TokenMeta } from "./types";

export function normalizeChainId(input: unknown): ChainId {
  const n = Number(input);
  return n === 4663 ? 4663 : 8453;
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
  let guess = head.number - BigInt(Math.round(Number(head.timestamp - target) / bt));
  if (guess < 0n) guess = 0n;
  let loN: bigint | null = null;
  let loT = 0n;
  for (let i = 0; i < 12; i++) {
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
      // no lower bound yet: extrapolate further back (overshoot 25% so the next probe lands below target)
      if (hiN === 0n) break;
      const back = BigInt(Math.ceil((Number(hiT - target) / bt) * 1.25)) + 1n;
      guess = hiN > back ? hiN - back : 0n;
      continue;
    }
    if (hiN - loN <= 1n) break;
    // interpolate inside [lo, hi]
    const spanT = hiT - loT;
    const next = spanT > 0n ? loN + ((hiN - loN) * (target - loT)) / spanT : (loN + hiN) / 2n;
    guess = next <= loN ? loN + 1n : next >= hiN ? hiN - 1n : next;
  }
  if (loN === null) throw new Error(`blockAtTimestamp: no block at or before ${ts} found`);
  const value = loN;
  tsBlockCache.set(key, { value, at: Date.now() });
  return value;
}

const tokenCache = new Map<string, { meta: TokenMeta; at: number }>();

/** ERC-20 metadata via one multicall. Returns null if the address does not behave like an ERC-20. */
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
