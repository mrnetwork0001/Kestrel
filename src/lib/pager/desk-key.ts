/** Desk-key primitives (dependency-free so both `auth.ts` and `store.ts` can import them without a cycle). */
import "server-only";
import { createHash, randomBytes } from "node:crypto";

export const DESK_KEY_RE = /^kst_[A-Za-z0-9_-]{20,64}$/;

/** 24 random bytes → 32 base64url chars after the prefix. */
export const newDeskKey = (): string => `kst_${randomBytes(24).toString("base64url")}`;

/** The only thing stored server-side: base64url(sha256(deskKey)) truncated to 22 chars (132 bits). */
export const deskIdFromKey = (key: string): string => createHash("sha256").update(key).digest("base64url").slice(0, 22);

export function isDeskKey(v: unknown): v is string {
  return typeof v === "string" && DESK_KEY_RE.test(v);
}
