/**
 * Desk-key auth. A desk key (`kst_…`) is a bearer capability held only by the browser / agent that created
 * the desk. The server stores ONLY `deskId = base64url(sha256(deskKey))[0:22]`, so a database leak cannot be
 * replayed. Keys are never logged, echoed in errors, or put in URLs other than the client-side `#desk=` fragment.
 */
import "server-only";
import { createHash } from "node:crypto";
import { apiError, clientIp } from "@/lib/api";
import { kvMissingInProd } from "@/lib/kv";
import { deskIdFromKey, isDeskKey } from "@/lib/pager/desk-key";
import { getDesk } from "@/lib/pager/store";
import type { Desk } from "@/lib/pager/types";

export { DESK_KEY_RE, deskIdFromKey, isDeskKey, newDeskKey } from "@/lib/pager/desk-key";

/** Extracts a well-formed desk key from `Authorization: Bearer kst_…`, else null. */
export function deskKeyFrom(req: Request): string | null {
  const m = /^Bearer\s+(kst_[A-Za-z0-9_-]{20,64})\s*$/.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

/** 503 when production would run on per-instance memory (watches would silently vanish). */
export function storageGuard(): Response | null {
  return kvMissingInProd() ? apiError("Pager storage not configured", 503) : null;
}

/**
 * Resolves the desk for a request: 401 when the bearer key is missing/malformed, 404 when no desk matches.
 * Also applies the storage guard. Returns the Desk or a ready-to-return Response.
 */
export async function requireDesk(req: Request): Promise<Desk | Response> {
  const guard = storageGuard();
  if (guard) return guard;
  const key = deskKeyFrom(req);
  if (!key) return apiError("Missing or malformed desk key (Authorization: Bearer kst_…)", 401);
  return requireDeskByKey(key);
}

/** Same as `requireDesk` for callers that receive the key out of band (e.g. MCP tool arguments). */
export async function requireDeskByKey(key: string): Promise<Desk | Response> {
  if (!isDeskKey(key)) return apiError("Malformed desk key", 401);
  let desk: Desk | null;
  try {
    desk = await getDesk(deskIdFromKey(key));
  } catch (e) {
    console.error(`[pager] desk lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return apiError("Pager storage unavailable", 503);
  }
  return desk ?? apiError("Desk not found (it may have been deleted)", 404);
}

/**
 * Privacy-preserving per-IP identifier for desk-creation caps: sha256(ip + UTC day + optional PAGER_IP_SALT).
 * Rotates daily, so it cannot be used to track a visitor across days.
 */
export function ipHash(req: Request): string {
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256")
    .update(`${clientIp(req)}|${day}|${process.env.PAGER_IP_SALT ?? ""}`)
    .digest("base64url")
    .slice(0, 22);
}
