import { type Address } from "viem";
import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { errMsg, parseAddress, parseChainId, SUPPORTED_CHAIN_IDS, SUPPORTED_CHAINS_TEXT } from "@/lib/engine/chain-utils";
import { cachedScan } from "@/lib/engine/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/scan?address=0x…&chainId=8453|4663[&mode=auto|wallet][&tokens=0x…,0x…] — unified live scan.
 * mode=wallet forces the wallet/approval scan for any address (Panic Bunker subject). Smart-contract wallets
 * (Safe, Coinbase Smart Wallet, ERC-4337, EIP-7702) are auto-classified as wallets in mode=auto too.
 * The brief is always the deterministic one; the LLM brief is POST /api/brief. `llm` is accepted and ignored.
 * Incomplete scans (a live read failed) are returned with `X-Kestrel-Scan-Status: degraded` and never cached.
 */
export async function GET(req: Request) {
  if (await rateLimited(req, 40)) return apiError("Rate limited — slow down.", 429);
  const url = new URL(req.url);
  const address = parseAddress(url.searchParams.get("address"));
  if (!address) return apiError("Query param `address` must be a valid 0x address.");
  const chainId = parseChainId(url.searchParams.get("chainId"));
  if (!chainId) return apiError(`Unsupported chainId. Kestrel scans ${SUPPORTED_CHAINS_TEXT} only.`, 400, { supportedChainIds: SUPPORTED_CHAIN_IDS });
  const rawMode = url.searchParams.get("mode");
  if (rawMode && rawMode !== "auto" && rawMode !== "wallet") return apiError("`mode` must be \"auto\" (default) or \"wallet\".");
  const mode = rawMode === "wallet" ? "wallet" : "auto";
  const extraTokens = (url.searchParams.get("tokens") ?? "")
    .split(",")
    .map((t) => parseAddress(t))
    .filter((t): t is Address => t !== null)
    .slice(0, 8);
  try {
    // cachedScan never stores a degraded scan and re-derives the status on cache hits too (the SSR pages share
    // the same KV key), so the header always reflects THIS result.
    const { result, degraded } = await cachedScan(chainId, address, { useLlm: false, extraTokens, mode });
    if (degraded.length) return json(result, { headers: { "X-Kestrel-Scan-Status": "degraded", "Retry-After": "15" } });
    return json(result, { headers: { "X-Kestrel-Scan-Status": "complete" } });
  } catch (e) {
    // The address could not be classified (bytecode / account / pool reads failed): UNKNOWN, retryable.
    return apiError(`Live scan unavailable: ${errMsg(e)}. Nothing was classified; retry shortly.`, 503, { status: "degraded", retryAfterSec: 15 });
  }
}

export const OPTIONS = preflight;
