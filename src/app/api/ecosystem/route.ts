import { after } from "next/server";
import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { getEcosystemBoard, readEcosystemRowByKey } from "@/lib/vibestarter/ecosystem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/ecosystem — Vibestarter Ecosystem Health Board: every Vibestarter launch on Base (8453) and
 *   Robinhood Chain (4663) with live token X-Ray score, Proof-of-Lock, pool depth, escrow state + next
 *   countdown, Refund Radar, founder app HTTP health, founder GitHub velocity and Origin Capsule status.
 *   Served from a 120 s stale-while-revalidate cache (`cache.ageSec`, `cache.stale` say how old it is).
 * GET /api/ecosystem?chainId=4663 — only launches on one chain.
 * GET /api/ecosystem?escrow=0x…&chainId=8453 — one launch row.
 * All uint256 values are decimal strings (wei / raw token units).
 */
export async function GET(req: Request) {
  if (await rateLimited(req, 30)) return apiError("Rate limit exceeded — try again in a minute.", 429);
  const url = new URL(req.url);
  const chainParam = url.searchParams.get("chainId") ?? url.searchParams.get("chain");
  const escrowParam = url.searchParams.get("escrow");
  try {
    if (escrowParam) {
      const escrow = parseAddress(escrowParam);
      if (!escrow) return apiError("`escrow` must be a valid 0x address.");
      const chainId = normalizeChainId(chainParam ?? 8453);
      const row = await readEcosystemRowByKey(chainId, escrow);
      if (!row) return apiError(`No Vibestarter launch with escrow ${escrow} on chain ${chainId}.`, 404);
      return json({ row }, { cache: "public, s-maxage=60, stale-while-revalidate=120" });
    }
    const board = await getEcosystemBoard({ onBackgroundRefresh: (p) => after(p) });
    if (chainParam) {
      const chainId = normalizeChainId(chainParam);
      return json({ ...board, rows: board.rows.filter((r) => r.chainId === chainId), filter: { chainId } }, { cache: "public, s-maxage=60, stale-while-revalidate=120" });
    }
    return json(board, { cache: "public, s-maxage=60, stale-while-revalidate=120" });
  } catch (e) {
    return apiError(`Ecosystem board read failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
