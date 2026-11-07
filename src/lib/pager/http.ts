/** Small HTTP helpers shared by the pager routes (body parsing, 204s, store-error mapping). */
import "server-only";
import { NextResponse } from "next/server";
import { CORS_HEADERS, apiError } from "@/lib/api";
import { StoreError } from "@/lib/pager/store";

export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Parses a JSON object body (≤ `maxBytes`). An empty body yields `{}` when `optional`. Anything that is not a
 * plain object (including `null`, arrays, invalid JSON) is a 400, never a 500.
 */
export async function readJsonObject(
  req: Request,
  { maxBytes = 16_384, optional = false }: { maxBytes?: number; optional?: boolean } = {}
): Promise<Record<string, unknown> | Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) return apiError(`Request body too large (max ${maxBytes} bytes)`, 413);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return apiError("Could not read request body", 400);
  }
  if (text.length > maxBytes) return apiError(`Request body too large (max ${maxBytes} bytes)`, 413);
  if (!text.trim()) return optional ? {} : apiError("JSON object body required", 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return apiError("Body is not valid JSON", 400);
  }
  if (!isObj(body)) return apiError("Body must be a JSON object", 400);
  return body;
}

/** Rejects keys outside `allowed` so typos never silently no-op. */
export function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): Response | null {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  return extra.length ? apiError(`Unknown field${extra.length > 1 ? "s" : ""}: ${extra.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}`, 400) : null;
}

export function noContent(): Response {
  return new NextResponse(null, { status: 204, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

/** Maps StoreError to its status; anything else is a storage outage (503), logged without secrets. */
export function storeFailure(e: unknown, what: string): Response {
  if (e instanceof StoreError) return apiError(e.message, e.status);
  console.error(`[pager] ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
  return apiError("Pager storage unavailable, try again shortly", 503);
}
