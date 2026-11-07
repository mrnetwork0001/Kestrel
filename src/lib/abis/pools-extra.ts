import { type Address, parseAbi } from "viem";

/**
 * Extra pool / proxy ABIs and venue addresses for the pool-discovery + X-Ray engine.
 * Every address below was verified live against Base / Robinhood Chain RPCs on 2026-11-07.
 */

/**
 * Concentrated-liquidity slot0 decoded to its FIRST TWO words only. Uniswap v3 returns 7 words
 * (… feeProtocol, unlocked) and Aerodrome Slipstream returns 6 (no feeProtocol); decoding only
 * (sqrtPriceX96, tick) works for both (verified: Slipstream WETH/USDC 0xb2cc…DC59 and Uniswap v3 CLANKER/WETH 0xc1a6…7f44).
 */
export const CL_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function factory() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);

/** Aerodrome v2 (volatile + stable) pool events used for overnight LP / flow reconstruction. */
export const AERODROME_POOL_EVENTS_ABI = parseAbi([
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1)",
]);

/** Aerodrome Slipstream CLFactory: pools are keyed by tick spacing, not fee. */
export const SLIPSTREAM_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
  "function tickSpacings() view returns (int24[])",
]);

export const UNISWAP_V3_FACTORY_FEE_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

/** IBeacon (EIP-1967 beacon proxies) + EIP-897 implementation() fallback. */
export const IMPLEMENTATION_ABI = parseAbi(["function implementation() view returns (address)"]);

/** OpenZeppelin AccessControl(Enumerable) — who holds DEFAULT_ADMIN_ROLE (bytes32(0)). */
export const ACCESS_CONTROL_ENUMERABLE_ABI = parseAbi([
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
]);

export const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** Uniswap v3 fee tiers in pips (1e-6). */
export const UNISWAP_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Base DEX venues scanned by pool discovery. */
export const BASE_POOL_VENUES = {
  /** Aerodrome v2 PoolFactory (volatile + stable). Same as CONTRACTS.base.aerodromeFactory. */
  aerodromeFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address,
  /**
   * Aerodrome Slipstream CLFactories. tickSpacings() verified live:
   * 0x5e7B…809A → [1, 50, 100, 200, 2000, 10] (factory() of the WETH/USDC CL pool 0xb2cc…DC59);
   * 0xaDe6…716a → [1, 50, 100, 200, 2000, 10, 500] (second-generation CL factory).
   */
  slipstreamFactories: [
    "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as Address,
    "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a" as Address,
  ],
  /** Fallback tick spacings when tickSpacings() is unreadable. */
  slipstreamTickSpacings: [1, 10, 50, 100, 200, 500, 2000] as const,
  /** Uniswap v3 factory on Base (factory() of CLANKER/WETH 0xc1a6…7f44 and WETH/USDC 0xd0b5…F224). */
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address,
} as const;

export function isSlipstreamFactory(chainId: number, factory: string | null | undefined): boolean {
  if (chainId !== 8453 || !factory) return false;
  const f = factory.toLowerCase();
  return BASE_POOL_VENUES.slipstreamFactories.some((a) => a.toLowerCase() === f);
}
