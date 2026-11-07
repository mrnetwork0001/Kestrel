import { type Address } from "viem";
import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/scan?address=0x…&chainId=8453|4663[&llm=0][&tokens=0x…,0x…] — unified live scan. */
export async function GET(req: Request) {
  if (rateLimited(req, 40)) return apiError("Rate limited — slow down.", 429);
  const url = new URL(req.url);
  const address = parseAddress(url.searchParams.get("address"));
  if (!address) return apiError("Query param `address` must be a valid 0x address.");
  const chainId = normalizeChainId(url.searchParams.get("chainId") ?? 8453);
  const extraTokens = (url.searchParams.get("tokens") ?? "")
    .split(",")
    .map((t) => parseAddress(t))
    .filter((t): t is Address => t !== null)
    .slice(0, 8);
  try {
    const result = await scanTarget(chainId, address, { useLlm: url.searchParams.get("llm") !== "0", extraTokens });
    return json(result);
  } catch (e) {
    return apiError(`Live scan failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
