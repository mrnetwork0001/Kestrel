import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { guardVerdict } from "@/lib/engine/guard";
import { buildRequirements, verifyPayment, X402_VERSION } from "@/lib/x402";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Pre-Trade Security Gate for AI agents.
 *  GET  /api/v1/guard?address=0x…&chainId=8453[&mode=preview|full]
 *  POST /api/v1/guard { address, chainId, mode }
 * mode=preview (default) is free. mode=full requires an x402 `X-PAYMENT` header (Base USDC, EIP-3009);
 * without it the endpoint answers HTTP 402 with x402 payment requirements.
 */
async function handle(req: Request, input: { address?: unknown; chainId?: unknown; mode?: unknown }) {
  if (rateLimited(req, 60)) return apiError("Rate limited.", 429);
  const address = parseAddress(input.address);
  if (!address) return apiError("`address` must be a valid 0x address.");
  const chainId = normalizeChainId(input.chainId ?? 8453);
  const mode = input.mode === "full" ? "full" : "preview";

  let paymentResponse: string | null = null;
  if (mode === "full") {
    const resource = new URL(req.url);
    resource.search = `?address=${address}&chainId=${chainId}&mode=full`;
    const requirements = buildRequirements(resource.toString());
    if (!requirements) return apiError("x402 is not configured on this deployment (X402_RECEIVER_ADDRESS unset). Use mode=preview.", 501);
    const header = req.headers.get("x-payment");
    if (!header) {
      return json({ x402Version: X402_VERSION, error: "X-PAYMENT header is required", accepts: [requirements] }, { status: 402 });
    }
    const v = await verifyPayment(header, requirements);
    if (!v.ok) return json({ x402Version: X402_VERSION, error: v.reason, accepts: [requirements] }, { status: 402 });
    paymentResponse = Buffer.from(JSON.stringify({ success: true, payer: v.payer, network: "base", settlement: v.settlement })).toString("base64");
  }

  try {
    const result = await guardVerdict(chainId, address, mode);
    return json(result, { headers: paymentResponse ? { "X-PAYMENT-RESPONSE": paymentResponse } : {} });
  } catch (e) {
    return apiError(`Guard scan failed: ${errMsg(e)}`, 502);
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle(req, { address: u.searchParams.get("address"), chainId: u.searchParams.get("chainId"), mode: u.searchParams.get("mode") });
}

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return apiError("Body must be JSON: { address, chainId, mode }.");
  }
  return handle(req, body);
}

export const OPTIONS = preflight;
