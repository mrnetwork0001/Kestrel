import { defineChain } from "viem";
import { chainConfig as opStackChainConfig } from "viem/op-stack";

/**
 * Base Mainnet — mirrors viem's own `base` definition (OP-stack formatters + Multicall3) but avoids
 * importing the `viem/chains` barrel, which drags every chain (and a dynamic-require warning) into bundles.
 */
export const baseMainnet = defineChain({
  ...opStackChainConfig,
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
  contracts: {
    ...opStackChainConfig.contracts,
    multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", blockCreated: 5022 },
  },
});

/**
 * Official Robinhood Chain Mainnet (Arbitrum Orbit L2)
 * Verified live RPC: https://rpc.mainnet.chain.robinhood.com -> chainId 0x1237 (4663)
 * Note: Server-side requests MUST send a clean User-Agent header to avoid Cloudflare 403s.
 */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.chain.robinhood.com"],
      webSocket: ["wss://feed.mainnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
  contracts: {
    // Canonical Multicall3 — verified deployed on Chain 4663 via eth_getCode (2026-11-04)
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export type SupportedChainId = 8453 | 4663;

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id === 8453 || id === 4663;
}

export const SUPPORTED_CHAINS = [baseMainnet, robinhoodMainnet] as const;

export const ROBINHOOD_FETCH_HEADERS = {
  "User-Agent": "Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)",
} as const;
