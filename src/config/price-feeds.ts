import type { Address } from "viem";

/**
 * Onchain ETH/USD reference used to show USD next to WETH amounts. No offchain oracle:
 * the price is the live slot0() of Uniswap v3's deepest Base WETH/USDC pool.
 * Verified live 2026-11-07: token0 = WETH (0x4200…0006), token1 = native USDC (0x8335…2913),
 * fee 500 (0.05%), factory 0x33128a8fC17869897dcE68Ed026d694621f6FDfD (Uniswap v3 on Base).
 */
export const ETH_USD_REFERENCE = {
  chainId: 8453,
  pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224" as Address,
  label: "Uniswap v3 WETH/USDC 0.05% (Base)",
  wethIsToken0: true,
  usdcDecimals: 6,
} as const;
