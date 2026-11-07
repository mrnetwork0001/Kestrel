import { NextResponse } from "next/server";
import { kvIncrWithExpiry, localIncrWithExpiry } from "@/lib/kv";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-PAYMENT, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE, Mcp-Session-Id",
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

export function clientIp(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "local";
  return ip.slice(0, 64);
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
