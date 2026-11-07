import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { generateBrief, llmConfigured, llmDailyCap } from "@/lib/engine/brief";
import { errMsg, parseAddress, parseChainId, SUPPORTED_CHAIN_IDS, SUPPORTED_CHAINS_TEXT } from "@/lib/engine/chain-utils";
import { scanDegradedReasons, scanTarget } from "@/lib/engine/scan";
import type { BriefResult } from "@/lib/engine/types";

export const runtime = "nodejs";
export const maxDuration = 60;

class Uncacheable extends Error {
  constructor(readonly brief: BriefResult) {
    super("uncacheable brief");
  }
}

/**
 * POST /api/brief { address, chainId } — Morning Desk Brief. The ONLY path that may call an LLM.
 * Provider order: 0G Compute Router → Anthropic → deterministic rule-based brief from live findings.
 * Guard rails: 10/min + 40/h per IP, 12 s LLM cap, shared daily LLM budget (BRIEF_LLM_DAILY_CAP, default 300),
 * every external string sanitized and fenced as untrusted data. Briefs are cached 120 s per target, except
 * for incomplete scans.
 */
export async function POST(req: Request) {
  if (await rateLimited(req, 10)) return apiError("Rate limited — slow down.", 429);
  if (await rateLimited(req, 40, { windowSec: 3600, route: "/api/brief:hour" })) return apiError("Hourly brief limit reached — try again later.", 429);
  let body: { address?: unknown; chainId?: unknown } = {};
  try {
    const b: unknown = await req.json();
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error("not an object");
    body = b as typeof body;
  } catch {
    return apiError("Body must be JSON: { address, chainId }.");
  }
  const address = parseAddress(body.address);
  if (!address) return apiError("`address` must be a valid 0x address.");
  const chainId = parseChainId(body.chainId);
  if (!chainId) return apiError(`Unsupported chainId. Kestrel reads ${SUPPORTED_CHAINS_TEXT} only.`, 400, { supportedChainIds: SUPPORTED_CHAIN_IDS });
  try {
    const scan = await scanTarget(chainId, address, { useLlm: false });
    const incomplete = scanDegradedReasons(scan).length > 0;
    let brief: BriefResult;
    try {
      brief = await cached(`brief:v2:${chainId}:${address.toLowerCase()}`, 120, async () => {
        const b = await generateBrief(scan, { useLlm: true });
        if (incomplete) throw new Uncacheable(b);
        return b;
      });
    } catch (e) {
      if (!(e instanceof Uncacheable)) throw e;
      brief = e.brief;
    }
    return json({
      brief,
      llm: { configured: llmConfigured(), dailyCap: llmDailyCap() },
      status: incomplete ? "degraded" : "complete",
      score: scan.score,
      band: scan.band,
      block: scan.block,
      target: scan.target,
    });
  } catch (e) {
    return apiError(`Brief unavailable: ${errMsg(e)}. Retry shortly.`, 503, { status: "degraded", retryAfterSec: 15 });
  }
}

export const OPTIONS = preflight;
