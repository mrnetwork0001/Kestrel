import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { baseMainnet, robinhoodMainnet, ROBINHOOD_FETCH_HEADERS } from "@/config/chains";

const basePrimaryRpc = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
const baseFallbackRpc = process.env.NEXT_PUBLIC_BASE_FALLBACK_RPC_URL || "https://base-rpc.publicnode.com";
const robinhoodRpc = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const BATCH = { batchSize: 50, wait: 8 } as const;

export const basePublicClient = createPublicClient({
  chain: baseMainnet,
  batch: { multicall: true },
  transport: fallback([
    http(basePrimaryRpc, { timeout: 10_000, batch: BATCH }),
    http(baseFallbackRpc, { timeout: 10_000, batch: BATCH }),
  ]),
}) as PublicClient;

/**
 * eth_getLogs over an 8h window (~14.4k Base blocks) is rejected by mainnet.base.org
 * but served by publicnode (verified 2026-11-04), so log queries prefer the fallback.
 */
export const baseLogsClient = createPublicClient({
  chain: baseMainnet,
  transport: fallback([
    http(baseFallbackRpc, { timeout: 15_000 }),
    http(basePrimaryRpc, { timeout: 15_000 }),
  ]),
}) as PublicClient;

export const robinhoodPublicClient = createPublicClient({
  chain: robinhoodMainnet,
  batch: { multicall: true },
  transport: http(robinhoodRpc, {
    timeout: 10_000,
    batch: BATCH,
    // Cloudflare WAF on Chain 4663 returns 403 for default bot User-Agents.
    fetchOptions: { headers: ROBINHOOD_FETCH_HEADERS },
  }),
}) as PublicClient;

export function getPublicClientForChain(chainId: number): PublicClient {
  if (chainId === 4663) return robinhoodPublicClient;
  return basePublicClient;
}

export function getLogsClientForChain(chainId: number): PublicClient {
  if (chainId === 4663) return robinhoodPublicClient;
  return baseLogsClient;
}

/** Wrap a promise so failures resolve to null (used for optional, best-effort reads). */
export async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
