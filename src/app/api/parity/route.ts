import { apiError, json, preflight } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg } from "@/lib/engine/chain-utils";
import { getBridgeParity } from "@/lib/engine/parity";

export const runtime = "nodejs";
export const maxDuration = 30;

/** GET /api/parity — live $VIBES OFT 1:1 proof-of-reserve + Base Aerodrome vs Robinhood Uniswap v3 spread. */
export async function GET() {
  try {
    return json(await cached("parity:full", 15, () => getBridgeParity()), { cache: "public, s-maxage=15, stale-while-revalidate=30" });
  } catch (e) {
    return apiError(`Parity read failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
