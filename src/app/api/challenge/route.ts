import { getAddress } from "viem";
import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { listEscrows } from "@/lib/engine/escrow";
import { buildChallengeBase, DRY_RUN_OUTCOMES, type DryRunOutcome, readChallengeCopilot, runChallengeDryRun } from "@/lib/vibestarter/challenge";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Backer Challenge Co-pilot (read side, zero-auth).
 *
 * GET  /api/challenge                                  → co-pilot summary for every known Vibestarter escrow (both chains)
 * GET  /api/challenge?escrow=0x…&chainId=8453[&wallet=0x…] → full report: phase, countdowns, bond, slash risk, trust surface,
 *                                                          readiness checklist in contract revert order, wallet eligibility
 * POST /api/challenge  { action: "dry-run", escrow, chainId, outcomes?: ["raise"|"reject"|"uphold"|"expire"] }
 *                                                       → eth_simulateV1 runs the REAL escrow code with a minimal state override
 */
export async function GET(req: Request) {
  if (await rateLimited(req, 30, { route: "challenge" })) return apiError("Rate limit exceeded (30/min). Retry shortly.", 429);
  const url = new URL(req.url);
  const escrowParam = url.searchParams.get("escrow");
  const walletParam = url.searchParams.get("wallet");
  try {
    if (!escrowParam) {
      const data = await cached("challenge:all:v1", 30, async () => {
        const list = await listEscrows();
        const reports = await Promise.all(
          list.map((e) =>
            cached(`challenge:base:v1:${e.chainId}:${e.address.toLowerCase()}`, 15, () => buildChallengeBase(e.chainId, getAddress(e.address))).catch((err) => ({
              chainId: e.chainId,
              escrow: e.address,
              title: e.title,
              error: errMsg(err),
            }))
          )
        );
        return { escrows: reports, fetchedAt: new Date().toISOString() };
      });
      return json(data, { cache: "public, s-maxage=15, stale-while-revalidate=30" });
    }
    const escrow = parseAddress(escrowParam);
    if (!escrow) return apiError("`escrow` must be a valid 0x address.");
    const chainId = normalizeChainId(url.searchParams.get("chainId") ?? 8453);
    let wallet = null;
    if (walletParam) {
      wallet = parseAddress(walletParam);
      if (!wallet) return apiError("`wallet` must be a valid 0x address.");
    }
    const base = await cached(`challenge:base:v1:${chainId}:${escrow.toLowerCase()}`, 15, () => buildChallengeBase(chainId, escrow));
    const report = await readChallengeCopilot(chainId, escrow, { wallet, base });
    return json(report, { cache: wallet ? "no-store" : "public, s-maxage=15, stale-while-revalidate=30" });
  } catch (e) {
    return apiError(`Challenge co-pilot read failed: ${errMsg(e)}`, 502);
  }
}

export async function POST(req: Request) {
  if (await rateLimited(req, 10, { route: "challenge-dry-run" })) return apiError("Rate limit exceeded (10 dry-runs/min). Retry shortly.", 429);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("Body must be JSON.");
  }
  if ((body.action ?? "dry-run") !== "dry-run") return apiError("Unsupported action. Use { action: \"dry-run\" }.");
  const escrow = parseAddress(body.escrow);
  if (!escrow) return apiError("`escrow` must be a valid 0x address.");
  const chainId = normalizeChainId(body.chainId ?? 8453);
  const requested = Array.isArray(body.outcomes) ? body.outcomes.filter((o): o is DryRunOutcome => DRY_RUN_OUTCOMES.includes(o as DryRunOutcome)) : DRY_RUN_OUTCOMES;
  const outcomes = requested.length ? requested : DRY_RUN_OUTCOMES;
  try {
    const data = await cached(`challenge:dryrun:v1:${chainId}:${escrow.toLowerCase()}:${outcomes.join(",")}`, 30, () => runChallengeDryRun(chainId, escrow, outcomes));
    return json(data);
  } catch (e) {
    return apiError(`Challenge dry-run failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
