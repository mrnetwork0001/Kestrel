import { after } from "next/server";
import { clientIp, json, preflight } from "@/lib/api";
import { getLastContact, getPulse } from "@/lib/engine/pulse";
import { localIncrWithExpiry } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pulse[?span=long] — the Sentinel Watch feed: every real Base + Robinhood Chain block of the recent
 * window (eth_feeHistory gasUsedRatio), Permit2 + $VIBES token/pool/OFT/escrow logs, OFT parity and the last
 * $VIBES contact. Memoised in-process (1.5 s / 10 s) and CDN-cached, so RPC load is independent of visitors.
 * A failing chain is reported per chain (`ok: false` + plain-text error); a body is never fabricated.
 */
export async function GET(req: Request) {
  if (localIncrWithExpiry(`rl:pulse:${clientIp(req)}`, 60) > 300) return json({ v: 1, error: "Rate limited: max 300 requests/min." }, { status: 429, headers: { "Retry-After": "30" } });
  const span = new URL(req.url).searchParams.get("span") === "long" ? "long" : "short";
  try {
    const pulse = await getPulse(span);
    if (!pulse.lastContact) after(() => getLastContact().then(() => undefined, () => undefined));
    return json(pulse, { cache: span === "long" ? "public, s-maxage=5, stale-while-revalidate=5" : "public, s-maxage=1, stale-while-revalidate=1" });
  } catch (e) {
    return json({ v: 1, error: e instanceof Error ? e.message.slice(0, 200) : "pulse unavailable", builtAt: Date.now() }, { status: 503 });
  }
}

export function OPTIONS() {
  return preflight();
}
