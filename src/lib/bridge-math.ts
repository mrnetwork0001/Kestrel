/**
 * BigInt helpers for OFT bridge economics (LayerZero dust, credit-budget waits, cross-venue round trips).
 * Everything is integer math on raw units; no Number() touches a uint256 before the final bps.
 */
import { quoteExactIn } from "@/lib/amm-math";

/** OFT dust removal: amounts are truncated to `decimalConversionRate` (1e12 wei for 18→6 shared decimals). */
export function removeDust(amountLD: bigint, decimalConversionRate: bigint): bigint {
  if (decimalConversionRate <= 1n) return amountLD;
  return (amountLD / decimalConversionRate) * decimalConversionRate;
}

/** `part` as signed bps of `whole` (floor toward zero). */
export function bpsOf(part: bigint, whole: bigint): number | null {
  if (whole === 0n) return null;
  return Number((part * 10_000n) / whole);
}

/**
 * Seconds until `amount` can be credited on a lane under LayerZero's RateLimiter (linear decay at limit/window per second).
 *  - returns 0n when it fits in the live headroom,
 *  - null when the lane is fail-closed (limit or window == 0),
 *  - amounts above `limit` can never be credited as ONE message (canCredit ≤ limit); the estimate assumes the sender splits into ≤limit chunks.
 */
export function creditWaitSeconds(amount: bigint, inFlight: bigint, limit: bigint, windowSec: bigint): bigint | null {
  if (limit === 0n || windowSec === 0n) return null;
  const headroom = limit > inFlight ? limit - inFlight : 0n;
  if (amount <= headroom) return 0n;
  const deficit = amount - headroom;
  return (deficit * windowSec + limit - 1n) / limit; // ceil(deficit / (limit / window))
}

export interface CpLeg {
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
}

export interface RoundTrip {
  wethIn: bigint;
  vibesBought: bigint;
  vibesBridged: bigint;
  wethOut: bigint;
  /** wethOut − wethIn − fixed costs (LZ fee + gas), may be negative */
  profitWei: bigint;
}

/** Buy VIBES with `wethIn` on the cheap venue, bridge (dust-truncated), sell on the rich venue, pay fixed costs. */
export function roundTrip(wethIn: bigint, buy: CpLeg, sell: CpLeg, dustRate: bigint, fixedCostWei: bigint): RoundTrip {
  const vibesBought = quoteExactIn(wethIn, buy.reserveIn, buy.reserveOut, buy.feeBps);
  const vibesBridged = removeDust(vibesBought, dustRate);
  const wethOut = quoteExactIn(vibesBridged, sell.reserveIn, sell.reserveOut, sell.feeBps);
  return { wethIn, vibesBought, vibesBridged, wethOut, profitWei: wethOut - wethIn - fixedCostWei };
}

/**
 * Profit-maximising size by BigInt ternary search (profit is concave in size for x·y=k legs with fixed costs).
 * Returns null when no size is profitable.
 */
export function optimalRoundTrip(buy: CpLeg, sell: CpLeg, dustRate: bigint, fixedCostWei: bigint, maxWethIn: bigint): RoundTrip | null {
  if (maxWethIn <= 0n) return null;
  let lo = 0n;
  let hi = maxWethIn;
  for (let i = 0; i < 256 && hi - lo > 1_000_000n; i++) {
    const m1 = lo + (hi - lo) / 3n;
    const m2 = hi - (hi - lo) / 3n;
    if (roundTrip(m1, buy, sell, dustRate, fixedCostWei).profitWei < roundTrip(m2, buy, sell, dustRate, fixedCostWei).profitWei) lo = m1;
    else hi = m2;
  }
  const best = roundTrip((lo + hi) / 2n, buy, sell, dustRate, fixedCostWei);
  return best.profitWei > 0n ? best : null;
}
