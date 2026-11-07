import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg } from "@/lib/engine/chain-utils";
import { x402RevenueReport } from "@/lib/engine/x402-revenue";
import { X402_CORS_HEADERS, x402Config, x402Error, x402Json } from "@/lib/x402";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/x402/revenue — onchain proof of x402 settlements into X402_RECEIVER_ADDRESS:
 * Base USDC Transfer logs summed in 50k-block windows from X402_LEDGER_FROM_BLOCK (incremental cursor in KV),
 * newest rows labelled as EIP-3009 settlements from their receipts, plus the server ledger count for cross-checking.
 * `configured: false` (HTTP 200) when this deployment has no receiver: there is honestly no revenue to report.
 */
export async function GET(req: Request) {
  if (await rateLimited(req, 30)) return x402Error("Rate limited.", 429);
  const { receiver } = x402Config();
  if (!receiver) return x402Json(await x402RevenueReport(), { cache: "public, s-maxage=60" });
  try {
    const report = await cached(`x402:revenue:report:${receiver.toLowerCase()}:${process.env.X402_LEDGER_FROM_BLOCK ?? "auto"}`, 60, x402RevenueReport);
    return x402Json(report, { cache: "public, s-maxage=60, stale-while-revalidate=300" });
  } catch (e) {
    return x402Error(`Revenue scan failed: ${errMsg(e)}`, 502);
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: X402_CORS_HEADERS });
}
