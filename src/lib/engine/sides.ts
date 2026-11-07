import { CONTRACTS } from "@/config/contracts";
import type { PoolSnapshot, TokenMeta } from "./types";

/**
 * Pure, client-safe pool-side resolution. The quote side (the asset you EXIT INTO) is decided
 * by ADDRESS per chain — never by symbol text — so a token named "WETH" cannot impersonate it.
 */

export interface QuoteAsset {
  address: string;
  symbol: string;
  decimals: number;
  /** Policy thresholds for exit depth on this side (raw units): below `thin` = critical, below `modest` = warn. */
  thin: bigint;
  modest: bigint;
}

/** Ordered by preference: when both sides are quote assets, the earlier one is the quote. */
export const QUOTE_ASSETS: Record<8453 | 4663, readonly QuoteAsset[]> = {
  8453: [
    { address: CONTRACTS.base.usdc, symbol: "USDC", decimals: 6, thin: 15_000n * 10n ** 6n, modest: 60_000n * 10n ** 6n },
    // Bridged USDbC (verified live: symbol USDbC, 6 decimals)
    { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", symbol: "USDbC", decimals: 6, thin: 15_000n * 10n ** 6n, modest: 60_000n * 10n ** 6n },
    { address: CONTRACTS.base.weth, symbol: "WETH", decimals: 18, thin: 5n * 10n ** 18n, modest: 20n * 10n ** 18n },
    // Coinbase cbBTC (verified live: symbol cbBTC, 8 decimals)
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8, thin: 15n * 10n ** 6n, modest: 60n * 10n ** 6n },
  ],
  4663: [{ address: CONTRACTS.robinhood.weth, symbol: "WETH", decimals: 18, thin: 5n * 10n ** 18n, modest: 20n * 10n ** 18n }],
};

export function wethAddress(chainId: number): string {
  return chainId === 4663 ? CONTRACTS.robinhood.weth : CONTRACTS.base.weth;
}

export function isWeth(chainId: number, address: string | null | undefined): boolean {
  return !!address && address.toLowerCase() === wethAddress(chainId).toLowerCase();
}

export function quoteAssetFor(chainId: number, address: string | null | undefined): QuoteAsset | null {
  if (!address) return null;
  const list = QUOTE_ASSETS[chainId === 4663 ? 4663 : 8453];
  const a = address.toLowerCase();
  return list.find((q) => q.address.toLowerCase() === a) ?? null;
}

function quoteRank(chainId: number, address: string): number {
  const list = QUOTE_ASSETS[chainId === 4663 ? 4663 : 8453];
  const i = list.findIndex((q) => q.address.toLowerCase() === address.toLowerCase());
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

export interface PoolSides {
  /** Side you exit into (USDC / WETH / … by address) — null when neither token is a known quote asset. */
  quoteSide: 0 | 1 | null;
  /** The other side: the token whose risk the pool expresses (falls back to token0 when no quote side). */
  riskySide: 0 | 1;
  quote: TokenMeta | null;
  risky: TokenMeta;
  quoteAsset: QuoteAsset | null;
  reserveQuote: bigint | null;
  reserveRisky: bigint;
  /** Which side is canonical WETH (by address), independent of the quote choice. */
  wethSide: 0 | 1 | null;
}

type SideInput = Pick<PoolSnapshot, "chainId" | "token0" | "token1" | "reserve0" | "reserve1">;

export function quoteSideOf(chainId: number, token0: string, token1: string): 0 | 1 | null {
  const r0 = quoteRank(chainId, token0);
  const r1 = quoteRank(chainId, token1);
  if (r0 === Number.POSITIVE_INFINITY && r1 === Number.POSITIVE_INFINITY) return null;
  return r0 <= r1 ? 0 : 1;
}

export function wethSideOf(chainId: number, token0: string, token1: string): 0 | 1 | null {
  return isWeth(chainId, token0) ? 0 : isWeth(chainId, token1) ? 1 : null;
}

export function poolSides(p: SideInput): PoolSides {
  const quoteSide = quoteSideOf(p.chainId, p.token0.address, p.token1.address);
  const riskySide: 0 | 1 = quoteSide === null ? 0 : quoteSide === 0 ? 1 : 0;
  const tok = (s: 0 | 1) => (s === 0 ? p.token0 : p.token1);
  const res = (s: 0 | 1) => BigInt(s === 0 ? p.reserve0 : p.reserve1);
  const quote = quoteSide === null ? null : tok(quoteSide);
  return {
    quoteSide,
    riskySide,
    quote,
    risky: tok(riskySide),
    quoteAsset: quote ? quoteAssetFor(p.chainId, quote.address) : null,
    reserveQuote: quoteSide === null ? null : res(quoteSide),
    reserveRisky: res(riskySide),
    wethSide: wethSideOf(p.chainId, p.token0.address, p.token1.address),
  };
}

/** Human venue label for a pool snapshot kind. */
export function venueLabel(p: Pick<PoolSnapshot, "kind" | "stable"> & { tickSpacing?: number | null }): string {
  if (p.kind === "aerodrome-cl") return `Aerodrome Slipstream CL${p.tickSpacing != null ? ` (tick spacing ${p.tickSpacing})` : ""}`;
  if (p.kind === "uniswap-v3") return "Uniswap v3";
  return `Aerodrome ${p.stable ? "stable" : "volatile"}`;
}
