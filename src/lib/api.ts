import { NextResponse } from "next/server";

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

/** Tiny in-memory sliding-window limiter (per instance). Good enough to blunt abuse of public RPC fan-out. */
const hits = new Map<string, number[]>();
export function rateLimited(req: Request, limit = 30, windowMs = 60_000): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5_000) hits.clear();
  return arr.length > limit;
}
