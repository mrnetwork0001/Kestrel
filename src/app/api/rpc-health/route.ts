import { ROBINHOOD_FETCH_HEADERS } from "@/config/chains";
import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { redactRpcUrl, rpcEndpointStatus, serverLogsRpcUrls, serverRpcUrls } from "@/lib/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Sem = { active: number; waiters: unknown[] };

/** Live eth_blockNumber round-trip to one endpoint. Only the redacted host is ever returned (URLs may carry keys). */
async function ping(chainId: number, url: string): Promise<{ endpoint: string; ms: number | null; block: string | null; error: string | null }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(chainId === 4663 ? ROBINHOOD_FETCH_HEADERS : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
    if (!res.ok || !body?.result) return { endpoint: redactRpcUrl(url), ms: Date.now() - t0, block: null, error: body?.error?.message?.slice(0, 120) ?? `HTTP ${res.status}` };
    return { endpoint: redactRpcUrl(url), ms: Date.now() - t0, block: BigInt(body.result).toString(), error: null };
  } catch (e) {
    return { endpoint: redactRpcUrl(url), ms: null, block: null, error: e instanceof Error ? e.name : "error" };
  }
}

/**
 * GET /api/rpc-health — server RPC fallback chains (hosts only, never keys), circuit-breaker state, eth_getLogs
 * concurrency slots in use, and (with ?probe=1) a live eth_blockNumber round-trip to every endpoint.
 */
export async function GET(req: Request) {
  if (await rateLimited(req, 20)) return apiError("Rate limited — slow down.", 429);
  const probe = new URL(req.url).searchParams.get("probe") === "1";
  const sems = (globalThis as typeof globalThis & { __kestrelLogsSem?: Map<string, Sem> }).__kestrelLogsSem;
  const logsSlots = sems
    ? [...sems.entries()].map(([key, s]) => {
        const [url, bg] = key.split("|");
        return { endpoint: redactRpcUrl(url), background: bg === "bg", active: s.active, queued: s.waiters.length };
      })
    : [];
  const pings = probe
    ? {
        base: await Promise.all(serverRpcUrls(8453).map((u) => ping(8453, u))),
        baseLogs: await Promise.all(serverLogsRpcUrls(8453).map((u) => ping(8453, u))),
        robinhood: await Promise.all(serverRpcUrls(4663).map((u) => ping(4663, u))),
      }
    : null;
  return json({ endpoints: rpcEndpointStatus(), logsSlots, pings, checkedAt: new Date().toISOString() });
}

export const OPTIONS = preflight;
