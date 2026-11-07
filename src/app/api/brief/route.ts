import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/brief { address, chainId } — Morning Desk Brief.
 * Provider order: 0G Compute Router → Anthropic → deterministic rule-based brief from live findings.
 */
export async function POST(req: Request) {
  if (rateLimited(req, 15)) return apiError("Rate limited — slow down.", 429);
  let body: { address?: string; chainId?: number } = {};
  try {
    body = await req.json();
  } catch {
    return apiError("Body must be JSON: { address, chainId }.");
  }
  const address = parseAddress(body.address);
  if (!address) return apiError("`address` must be a valid 0x address.");
  try {
    const scan = await scanTarget(normalizeChainId(body.chainId ?? 8453), address, { useLlm: true });
    return json({ brief: scan.brief, score: scan.score, band: scan.band, block: scan.block, target: scan.target });
  } catch (e) {
    return apiError(`Brief failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
