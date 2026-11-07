import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { errMsg } from "@/lib/engine/chain-utils";
import { getRibbonTelemetryCached } from "@/lib/ribbon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/telemetry — live Base + Robinhood Chain block heights and the $VIBES OFT 1:1 invariant (ribbon feed). */
export async function GET(req: Request) {
  if (await rateLimited(req, 120)) return apiError("Rate limited — slow down.", 429);
  try {
    return json(await getRibbonTelemetryCached(), { cache: "public, s-maxage=15, stale-while-revalidate=30" });
  } catch (e) {
    return apiError(`Telemetry read failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
