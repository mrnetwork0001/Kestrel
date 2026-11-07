/**
 * Exact BigInt AMM Pricing & Stress-Test Simulation Helpers
 * Supports:
 *  - Constant-product v2 / Aerodrome volatile pools (reserve0, reserve1)
 *  - Uniswap v3 concentrated liquidity pools (sqrtPriceX96, liquidity)
 */

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const PRECISION = 10n ** 18n;

/**
 * Compute token1 per 1 WETH (token0) and WETH (token0) per 1 token1
 * for a constant-product pool where both tokens have 18 decimals.
 */
export function computeV2SpotPrice18(reserve0Weth: bigint, reserve1Token: bigint) {
  if (reserve0Weth === 0n || reserve1Token === 0n) {
    return { wethPerTokenScaled18: 0n, tokensPerWethScaled18: 0n };
  }
  const wethPerTokenScaled18 = (reserve0Weth * PRECISION) / reserve1Token;
  const tokensPerWethScaled18 = (reserve1Token * PRECISION) / reserve0Weth;
  return { wethPerTokenScaled18, tokensPerWethScaled18 };
}

/**
 * Compute price from Uniswap v3 slot0 sqrtPriceX96 where token0 = WETH (18 dec) and token1 = Token (18 dec).
 * In Uniswap v3, (sqrtPriceX96 / 2^96)^2 = token1 / token0 = tokensPerWeth.
 */
export function computeUniV3SpotPrice18(sqrtPriceX96: bigint) {
  if (sqrtPriceX96 === 0n) {
    return { wethPerTokenScaled18: 0n, tokensPerWethScaled18: 0n };
  }
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const tokensPerWethScaled18 = (numerator * PRECISION) / Q192;
  const wethPerTokenScaled18 =
    tokensPerWethScaled18 > 0n ? (PRECISION * PRECISION) / tokensPerWethScaled18 : 0n;

  // Guard against extreme precision loss if price is tiny
  if (tokensPerWethScaled18 === 0n && numerator > 0n) {
    const fallbackWethPerToken = (Q192 * PRECISION) / numerator;
    return { wethPerTokenScaled18: fallbackWethPerToken, tokensPerWethScaled18: 0n };
  }

  return { wethPerTokenScaled18, tokensPerWethScaled18 };
}

/**
 * Compute percentage spread in basis points (bps) between two scaled-18 prices:
 * ((priceB - priceA) / priceA) * 10_000
 */
export function computeSpreadBps(priceAScaled18: bigint, priceBScaled18: bigint): number {
  if (priceAScaled18 === 0n) return 0;
  const diffBps = ((priceBScaled18 - priceAScaled18) * 10_000n) / priceAScaled18;
  return Number(diffBps);
}

/**
 * "Simulate the Rug" — Constant-Product Sell Impact & LP Removal Simulator
 * Given current reserves (reserveWeth, reserveToken):
 *  1. Applies an optional LP removal shock (lpPullBps: 0..9900, e.g., 5000 = 50% LP pulled)
 *  2. Applies an optional Whale Token Dump (whaleDumpTokenAmount sold into pool with feeBps, default 30 bps = 0.3%)
 *  3. Quotes how much WETH a user receives when exiting `userTokenBalance` AFTER the shock vs BEFORE the shock.
 */
export function simulateConstantProductShock(params: {
  reserveWeth: bigint;
  reserveToken: bigint;
  whaleDumpTokenAmount: bigint;
  lpPullBps: number; // 0 to 9500
  userTokenBalance: bigint;
  feeBps?: number; // default 30 (0.3%)
}) {
  const feeBps = BigInt(params.feeBps ?? 30);
  const clampedLpPull = BigInt(Math.max(0, Math.min(9500, Math.floor(params.lpPullBps))));

  const quoteOut = (amountIn: bigint, rIn: bigint, rOut: bigint): bigint => {
    if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
    const amountInWithFee = amountIn * (10_000n - feeBps);
    const numerator = amountInWithFee * rOut;
    const denominator = rIn * 10_000n + amountInWithFee;
    return numerator / denominator;
  };

  // Baseline user exit value before shock
  const baselineExitWeth = quoteOut(
    params.userTokenBalance,
    params.reserveToken,
    params.reserveWeth
  );

  // Step 1: Apply LP removal proportionally
  let postWeth = (params.reserveWeth * (10_000n - clampedLpPull)) / 10_000n;
  let postToken = (params.reserveToken * (10_000n - clampedLpPull)) / 10_000n;

  // Step 2: Apply whale token dump into remaining pool
  const whaleExtractedWeth = quoteOut(params.whaleDumpTokenAmount, postToken, postWeth);
  postWeth = postWeth > whaleExtractedWeth ? postWeth - whaleExtractedWeth : 0n;
  postToken = postToken + params.whaleDumpTokenAmount;

  // Step 3: User tries to exit after the shock
  const postShockExitWeth = quoteOut(params.userTokenBalance, postToken, postWeth);

  const drawdownBps =
    baselineExitWeth > 0n
      ? Number(((baselineExitWeth - postShockExitWeth) * 10_000n) / baselineExitWeth)
      : 0;

  return {
    baselineExitWeth,
    postShockExitWeth,
    whaleExtractedWeth,
    postReserveWeth: postWeth,
    postReserveToken: postToken,
    drawdownBps,
    drawdownPercent: drawdownBps / 100,
  };
}

/* ------------------------------------------------------------------------- */
/* Decimal-aware helpers (all BigInt, no Number casts of raw uint256 values)  */
/* ------------------------------------------------------------------------- */

const TEN = 10n;

/** token1-per-token0 and token0-per-token1 prices, scaled 1e18, for arbitrary decimals. */
export function v2PricesScaled18(reserve0: bigint, reserve1: bigint, dec0: number, dec1: number) {
  if (reserve0 === 0n || reserve1 === 0n) return { token1PerToken0: 0n, token0PerToken1: 0n };
  const s0 = TEN ** BigInt(dec0);
  const s1 = TEN ** BigInt(dec1);
  return {
    token1PerToken0: (reserve1 * s0 * PRECISION) / (reserve0 * s1),
    token0PerToken1: (reserve0 * s1 * PRECISION) / (reserve1 * s0),
  };
}

/** Uniswap v3 slot0 prices, scaled 1e18, for arbitrary decimals. */
export function v3PricesScaled18(sqrtPriceX96: bigint, dec0: number, dec1: number) {
  if (sqrtPriceX96 === 0n) return { token1PerToken0: 0n, token0PerToken1: 0n };
  const s0 = TEN ** BigInt(dec0);
  const s1 = TEN ** BigInt(dec1);
  const num = sqrtPriceX96 * sqrtPriceX96;
  return {
    token1PerToken0: (num * s0 * PRECISION) / (Q192 * s1),
    token0PerToken1: (Q192 * s1 * PRECISION) / (num * s0),
  };
}

/**
 * Virtual reserves of the active Uniswap v3 range: x = L·2^96/√P, y = L·√P/2^96.
 * Constant-product math on these is exact for swaps that stay inside the current
 * liquidity L (no tick crossings).
 */
export function v3VirtualReserves(sqrtPriceX96: bigint, liquidity: bigint) {
  if (sqrtPriceX96 === 0n) return { reserve0: 0n, reserve1: 0n };
  return {
    reserve0: (liquidity * Q96) / sqrtPriceX96,
    reserve1: (liquidity * sqrtPriceX96) / Q96,
  };
}

/** Constant-product exact-input quote with fee in bps. */
export function quoteExactIn(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * (10_000n - BigInt(feeBps));
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}

/** Price impact (bps) of selling `amountIn` vs the marginal spot price, fee excluded. */
export function priceImpactBps(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): number {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0;
  const out = quoteExactIn(amountIn, reserveIn, reserveOut, feeBps);
  const spotOut = (amountIn * reserveOut * (10_000n - BigInt(feeBps))) / (reserveIn * 10_000n);
  if (spotOut === 0n) return 0;
  return Number(((spotOut - out) * 10_000n) / spotOut);
}
