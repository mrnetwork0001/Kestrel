import { apiError, json, preflight } from "@/lib/api";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { readAllEscrows, readEscrow } from "@/lib/engine/escrow";
import { escrowFindings } from "@/lib/engine/findings";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * GET /api/backer-shield — every known Vibestarter tranche escrow (Base + Robinhood Chain), live.
 * GET /api/backer-shield?escrow=0x…&chainId=8453 — one escrow in depth (incl. founder app health probe).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const escrowParam = url.searchParams.get("escrow");
  try {
    if (escrowParam) {
      const escrow = parseAddress(escrowParam);
      if (!escrow) return apiError("`escrow` must be a valid 0x address.");
      const report = await readEscrow(normalizeChainId(url.searchParams.get("chainId") ?? 8453), escrow, { probeApp: true });
      return json({ escrow: report, findings: escrowFindings(report) });
    }
    const escrows = await readAllEscrows();
    return json(
      { escrows: escrows.map((e) => ({ ...e, findings: escrowFindings(e) })), fetchedAt: new Date().toISOString() },
      { cache: "public, s-maxage=30, stale-while-revalidate=60" }
    );
  } catch (e) {
    return apiError(`Backer Shield read failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
