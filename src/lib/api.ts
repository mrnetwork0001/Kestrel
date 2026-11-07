import { NextResponse } from "next/server";
import { kvIncrWithExpiry, localIncrWithExpiry } from "@/lib/kv";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  // x402 v2 (PAYMENT-SIGNATURE) + v1 (X-PAYMENT) request headers; MCP session headers.
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  // x402 v2 (PAYMENT-REQUIRED / PAYMENT-RESPONSE) + v1 (X-PAYMENT-RESPONSE) response headers must be readable by browser agents.
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Mcp-Session-Id, Retry-After",
  "Access-Control-Max-Age": "86400",
} as const;

export function json(data: unknown, init: { status?: number; headers?: Record<string, string>; cache?: string } = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: { ...CORS_HEADERS, "Cache-Control": init.cache ?? "no-store", ...(init.headers ?? {}) },
  });
}

export function apiError(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return json({ error: message, ...extra }, { status });
}

export function preflight() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Client network key for rate limiting / per-network caps. IPv4 is kept whole; IPv6 is bucketed to its /64
 * (one subscriber's allocation), so rotating addresses inside a single /64 cannot multiply per-IP limits.
 */
export function clientIp(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "local";
  return networkKey(ip).slice(0, 64);
}

/** IPv6 → "<first four hextets>::/64"; IPv4-mapped IPv6 → the IPv4; anything else unchanged. */
export function networkKey(raw: string): string {
  let ip = raw.trim();
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) ip = bracket[1];
  ip = ip.replace(/%.*$/, ""); // zone id
  if (!ip.includes(":")) return ip.replace(/:\d+$/, "");
  const mapped = ip.match(/^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i) ?? ip.match(/^::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  if (!h.concat(t).every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (full.length !== 8) return ip;
  return `${full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Fixed-window rate limiter shared across serverless instances (KV-backed; per-process when KV is absent).
 * Keyed by client IP + route (defaults to the request path). `cost` charges several units for one request
 * (e.g. a JSON-RPC batch). Fails open to a process-local counter if KV is unreachable.
 */
export async function rateLimited(
  req: Request,
  limit = 30,
  { cost = 1, windowSec = 60, route }: { cost?: number; windowSec?: number; route?: string } = {}
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rl:${route ?? new URL(req.url).pathname}:${clientIp(req)}:${bucket}`;
  const units = Math.max(1, Math.ceil(cost));
  let count: number;
  try {
    count = await kvIncrWithExpiry(key, windowSec, units);
  } catch (e) {
    console.warn(`[rate-limit] KV unavailable, using local counter: ${e instanceof Error ? e.message : String(e)}`);
    count = localIncrWithExpiry(key, windowSec, units);
  }
  return count > limit;
}
