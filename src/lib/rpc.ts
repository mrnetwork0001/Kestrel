import { createPublicClient, fallback, http, type HttpTransportConfig, type PublicClient, type Transport } from "viem";
import { baseMainnet, robinhoodMainnet, ROBINHOOD_FETCH_HEADERS } from "@/config/chains";

/**
 * SERVER-SIDE RPC configuration. Browser transports live in src/lib/wagmi.ts and read only NEXT_PUBLIC_*; nothing
 * here may be imported by a client component (the server-only env vars below would be undefined there anyway).
 *
 * Optional env (server-only, so keyed provider URLs such as Alchemy / QuickNode / dRPC are never inlined into the
 * browser bundle). Each list is tried in order, and the public endpoints are always appended as a last resort:
 *   BASE_RPC_URLS           comma-separated Base read RPCs (BASE_RPC_URL = a single one, tried first)
 *   ROBINHOOD_RPC_URLS      comma-separated Robinhood Chain RPCs (ROBINHOOD_RPC_URL = a single one, tried first)
 *   BASE_LOGS_RPC_URL       an indexed Base RPC for eth_getLogs (also used by engine/logs.ts)
 *
 * Verified public endpoints (2026-11-07):
 *   Base reads:  mainnet.base.org (refuses eth_getLogs with -32011 even for 100 blocks) → base-rpc.publicnode.com
 *   Base logs:   base-rpc.publicnode.com only (≤ 50k blocks, ≤ 10 addresses, ≤ 20k results, address required).
 *                Base has 200 ms blocks since 2026-11-05, so 8 h ≈ 144k blocks: use getLogsChunked (engine/logs.ts)
 *                for any multi-chunk range; the logs client here is for single-window reads.
 *   Robinhood:   rpc.mainnet.chain.robinhood.com → robinhood-rpc.publicnode.com → robinhood.drpc.org (all answer
 *                chainId 0x1237, JSON-RPC batches and eth_call). Every Robinhood transport sends the Kestrel
 *                User-Agent: the official RPC's Cloudflare WAF returns HTTP 403 to default bot User-Agents.
 *
 * Resilience: one fallback retry (not viem's default 3 × every transport), and a per-endpoint circuit breaker:
 * an endpoint that answers 429 / 5xx / timeouts / rate-limit codes is skipped for a few seconds while a later one
 * is healthy, so a throttled primary no longer adds a failed round-trip to every read under load.
 * Secrets: endpoint URLs are scrubbed from viem error messages (viem prints `URL: …`), so a keyed URL can't leak
 * through an API error body or a log line.
 */

const PUBLIC = {
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  baseLogs: ["https://base-rpc.publicnode.com"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
} as const;

/** Hosts known to refuse eth_getLogs outright — never used for logs, and getLogs is excluded on their read transports. */
const NO_LOGS_HOSTS = new Set(["mainnet.base.org"]);

function envList(...names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    for (const raw of (process.env[n] ?? "").split(",")) {
      const v = raw.trim();
      if (v && /^https?:\/\//i.test(v)) out.push(v);
    }
  }
  return out;
}

function dedupe(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((u) => {
    const k = u.replace(/\/+$/, "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "rpc";
  }
}

/** Display-safe form of an RPC URL: host only when the URL carries a path/query (where providers put API keys). */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    if ((u.pathname && u.pathname !== "/") || u.search || u.username || u.password) return `${u.protocol}//${u.host}/…`;
    return `${u.protocol}//${u.host}`;
  } catch {
    return "rpc";
  }
}

/** Ordered server-side read RPCs for a chain (env first, public last). Treat as secret: may contain API keys. */
export function serverRpcUrls(chainId: number): string[] {
  if (chainId === 4663) return dedupe([...envList("ROBINHOOD_RPC_URL", "ROBINHOOD_RPC_URLS"), ...PUBLIC.robinhood]);
  return dedupe([...envList("BASE_RPC_URL", "BASE_RPC_URLS"), ...PUBLIC.base]);
}

/** Ordered server-side eth_getLogs RPCs. Base never falls back to mainnet.base.org (it refuses getLogs). */
export function serverLogsRpcUrls(chainId: number): string[] {
  if (chainId === 4663) return serverRpcUrls(4663);
  return dedupe([...envList("BASE_LOGS_RPC_URL"), ...PUBLIC.baseLogs]).filter((u) => !NO_LOGS_HOSTS.has(hostOf(u)));
}

// ── circuit breaker (process-wide; survives Next dev HMR) ─────────────────────────────────────────────────────
interface EndpointHealth {
  until: number;
  fails: number;
  lastError: string;
}
const g = globalThis as typeof globalThis & { __kestrelRpcHealth?: Map<string, EndpointHealth> };
const health = (g.__kestrelRpcHealth ??= new Map());
const COOLDOWN_BASE_MS = 4_000;
const COOLDOWN_MAX_MS = 60_000;

function cooling(url: string, now = Date.now()): boolean {
  const h = health.get(url);
  return !!h && h.until > now;
}

const TRANSIENT_CODES = new Set([429, -32005, -32007, -32011, -32016, -32090]);
const TRANSIENT_MSG = /rate.?limit|request limit|too many requests|capacity|over quota|daily limit|exceeded the (?:compute|request)|temporarily unavailable|timed? ?out|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** Throttling / availability failures (not reverts, not bad params, not pruned state). */
function isTransient(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const x = e as { name?: string; status?: number; code?: number; message?: string; details?: string; cause?: unknown };
    if (x.name === "TimeoutError" || x.name === "AbortError") return true;
    if (x.name === "HttpRequestError") return x.status === undefined || x.status === 403 || x.status === 408 || x.status === 429 || x.status >= 500;
    if (typeof x.code === "number" && TRANSIENT_CODES.has(x.code)) return true;
    const text = `${x.details ?? ""} ${x.name === "RpcRequestError" ? (x.message ?? "") : ""}`;
    if (/revert/i.test(text)) return false; // a revert reason can contain any word ("exceeds capacity")
    if (TRANSIENT_MSG.test(text)) return true;
    e = x.cause;
  }
  return false;
}

function trip(url: string, err: unknown) {
  const prev = health.get(url);
  const fails = Math.min((prev?.fails ?? 0) + 1, 8);
  const ms = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (fails - 1));
  const msg = err && typeof err === "object" && "shortMessage" in err ? String((err as { shortMessage?: unknown }).shortMessage) : String(err);
  health.set(url, { until: Date.now() + ms, fails, lastError: scrubString(msg, url).slice(0, 160) });
}

function scrubString(s: string, url: string): string {
  const red = redactRpcUrl(url);
  return red === url || !s.includes(url) ? s : s.split(url).join(red);
}

/** Replace the raw endpoint URL in a viem error chain (message, shortMessage, details, metaMessages, url, stack). */
function scrubError(err: unknown, url: string) {
  if (redactRpcUrl(url) === url) return;
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    const x = e as Record<string, unknown>;
    for (const k of ["message", "shortMessage", "details", "stack", "url"]) {
      const v = x[k];
      if (typeof v === "string" && v.includes(url)) {
        try {
          x[k] = scrubString(v, url);
        } catch {
          /* read-only property */
        }
      }
    }
    if (Array.isArray(x.metaMessages)) {
      try {
        x.metaMessages = (x.metaMessages as unknown[]).map((m) => (typeof m === "string" ? scrubString(m, url) : m));
      } catch {
        /* read-only */
      }
    }
    e = x.cause;
  }
}

class EndpointCoolingError extends Error {
  constructor(url: string) {
    super(`RPC endpoint ${redactRpcUrl(url)} is cooling down after rate-limit/availability errors`);
    this.name = "EndpointCoolingError";
  }
}

/**
 * http() wrapped with the circuit breaker + error scrubbing. `later` lists the endpoints after this one in the same
 * fallback group: a cooling endpoint is skipped only when one of them is healthy (otherwise it is tried anyway).
 */
function guardedHttp(url: string, later: readonly string[], cfg: HttpTransportConfig): Transport {
  const inner = http(url, cfg);
  return ((params: Parameters<Transport>[0]) => {
    const t = inner(params);
    const request = (async (args: Parameters<typeof t.request>[0], opts?: Parameters<typeof t.request>[1]) => {
      if (cooling(url) && later.some((u) => !cooling(u))) throw new EndpointCoolingError(url);
      try {
        const res = await t.request(args, opts);
        if (health.has(url)) health.delete(url);
        return res;
      } catch (err) {
        if (isTransient(err)) trip(url, err);
        scrubError(err, url);
        throw err;
      }
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
}

const BATCH = { batchSize: 50, wait: 8 } as const;

function transportFor(urls: readonly string[], opts: { timeout: number; batch: boolean; robinhood: boolean; logs: boolean }): Transport {
  const list = urls.map((url, i) => {
    const cfg: HttpTransportConfig = {
      timeout: opts.timeout,
      ...(opts.batch ? { batch: BATCH } : {}),
      // Cloudflare WAF on Chain 4663 returns 403 for default bot User-Agents — send ours to every Robinhood endpoint.
      ...(opts.robinhood ? { fetchOptions: { headers: ROBINHOOD_FETCH_HEADERS } } : {}),
      // A read transport on a host that refuses getLogs skips straight to the next endpoint for log queries.
      ...(!opts.logs && NO_LOGS_HOSTS.has(hostOf(url)) ? { methods: { exclude: ["eth_getLogs", "eth_newFilter", "eth_getFilterLogs"] } } : {}),
    };
    return guardedHttp(url, urls.slice(i + 1), cfg);
  });
  // Always wrapped: a bare single-URL http() keeps viem's default 3 retries × timeout (~61 s for one slow logs
  // call); fallback() runs inner transports with retryCount 0 and retries the whole request once.
  return fallback(list, { retryCount: 1, retryDelay: 250 });
}

export const basePublicClient = createPublicClient({
  chain: baseMainnet,
  batch: { multicall: true },
  transport: transportFor(serverRpcUrls(8453), { timeout: 10_000, batch: true, robinhood: false, logs: false }),
}) as PublicClient;

/**
 * Single-window Base eth_getLogs / eth_simulateV1 client: BASE_LOGS_RPC_URL (if set) → publicnode. Never
 * mainnet.base.org. publicnode caps a query at 50k blocks and 10 addresses (8 h ≈ 144k blocks at 200 ms), so
 * anything wider must go through getLogsChunked in engine/logs.ts.
 */
export const baseLogsClient = createPublicClient({
  chain: baseMainnet,
  transport: transportFor(serverLogsRpcUrls(8453), { timeout: 15_000, batch: false, robinhood: false, logs: true }),
}) as PublicClient;

export const robinhoodPublicClient = createPublicClient({
  chain: robinhoodMainnet,
  batch: { multicall: true },
  transport: transportFor(serverRpcUrls(4663), { timeout: 10_000, batch: true, robinhood: true, logs: false }),
}) as PublicClient;

export function getPublicClientForChain(chainId: number): PublicClient {
  if (chainId === 4663) return robinhoodPublicClient;
  return basePublicClient;
}

export function getLogsClientForChain(chainId: number): PublicClient {
  if (chainId === 4663) return robinhoodPublicClient;
  return baseLogsClient;
}

/** Display-safe endpoint health (hosts only, never keys) for diagnostics / telemetry. */
export function rpcEndpointStatus(): { chainId: number; role: "read" | "logs"; endpoint: string; cooling: boolean; fails: number; lastError: string | null }[] {
  const now = Date.now();
  const rows: { chainId: number; role: "read" | "logs"; url: string }[] = [
    ...serverRpcUrls(8453).map((url) => ({ chainId: 8453, role: "read" as const, url })),
    ...serverLogsRpcUrls(8453).map((url) => ({ chainId: 8453, role: "logs" as const, url })),
    ...serverRpcUrls(4663).map((url) => ({ chainId: 4663, role: "read" as const, url })),
  ];
  return rows.map(({ chainId, role, url }) => {
    const h = health.get(url);
    return { chainId, role, endpoint: redactRpcUrl(url), cooling: !!h && h.until > now, fails: h?.fails ?? 0, lastError: h?.lastError ?? null };
  });
}

/** Wrap a promise so failures resolve to null (used for optional, best-effort reads). */
export async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
