import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { readAllEscrows, readEscrow } from "@/lib/engine/escrow";
import { escrowFindings } from "@/lib/engine/findings";
import { readLaunchUniverse } from "@/lib/vibestarter/launches";
import { vibestarterPulse } from "@/lib/vibestarter/pulse";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * GET /api/backer-shield — every known Vibestarter tranche escrow (Base + Robinhood Chain), live, with
 *   founder app HTTP health, founder GitHub velocity, on-chain Proof-of-Lock, Refund Radar and next-event countdowns.
 * GET /api/backer-shield?escrow=0x…&chainId=8453 — one escrow in depth.
 * GET /api/backer-shield?view=pulse — Vibestarter Pulse (via Vibestarter MCP) + on-chain liquidity reconciliation.
 */
export async function GET(req: Request) {
  if (await rateLimited(req, 40)) return apiError("Rate limit exceeded — try again in a minute.", 429);
  const url = new URL(req.url);
  const escrowParam = url.searchParams.get("escrow");
  try {
    if (url.searchParams.get("view") === "pulse") {
      return json(await vibestarterPulse(), { cache: "public, s-maxage=30, stale-while-revalidate=60" });
    }
    if (escrowParam) {
      const escrow = parseAddress(escrowParam);
      if (!escrow) return apiError("`escrow` must be a valid 0x address.");
      const chainId = normalizeChainId(url.searchParams.get("chainId") ?? 8453);
      const data = await cached(`backer-shield:v2:${chainId}:${escrow.toLowerCase()}`, 60, async () => {
        const report = await readEscrow(chainId, escrow);
        return { escrow: report, findings: escrowFindings(report) };
      });
      return json(data);
    }
    const data = await cached("backer-shield:all:v2", 60, async () => {
      const [escrows, universe] = await Promise.all([readAllEscrows(), readLaunchUniverse().catch(() => null)]);
      return {
        escrows: escrows.map((e) => ({ ...e, findings: escrowFindings(e) })),
        universe: universe ? { factories: universe.factories, mcp: universe.mcp, restCount: universe.restCount, launches: universe.launches.map((l) => ({ key: l.key, sources: l.sources, factoryLabel: l.factoryLabel, mcpStatus: l.mcpStatus })) } : null,
        fetchedAt: new Date().toISOString(),
      };
    });
    return json(data, { cache: "public, s-maxage=30, stale-while-revalidate=60" });
  } catch (e) {
    return apiError(`Backer Shield read failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
