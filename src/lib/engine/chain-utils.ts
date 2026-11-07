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
