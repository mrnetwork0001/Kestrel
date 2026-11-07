/**
 * Scheduler authentication for /api/pager/tick (zero dependencies).
 *
 *  - `Authorization: Bearer $CRON_SECRET` — Vercel Cron / Vercel Schedules / cron-job.org.
 *  - `Upstash-Signature` — QStash JWT (HS256 over the UTF-8 bytes of the signing key, like the official
 *    `Receiver`), verified against QSTASH_CURRENT_SIGNING_KEY then QSTASH_NEXT_SIGNING_KEY (key rotation).
 *    Claims checked: iss = "Upstash", exp / nbf (±5 s skew), sub pathname = this route, body = base64url(sha256(raw body)).
 *  - Local development only: when NO scheduler secret is configured and the server runs under `next dev`,
 *    requests addressed to localhost are accepted (`via: "dev-open"`) so the tick can be exercised without setup.
 */
import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type SchedulerVia = "cron-secret" | "qstash" | "dev-open";

export type SchedulerAuth =
  | { ok: true; via: SchedulerVia; executionId: string | null }
  | { ok: false; reason: string };

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

interface QstashClaims {
  iss?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  body?: string;
}

/** Verifies one QStash JWT against one signing key. Exported for tests. */
export function verifyQstashJwt(
  token: string,
  key: string,
  rawBody: string,
  reqUrl: string,
  nowSec = Math.floor(Date.now() / 1000)
): { ok: true; jti: string | null } | { ok: false; reason: string } {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed JWT" };
  const [h, p, s] = parts;
  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed JWT header" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "unsupported JWT alg" };
  const expect = createHmac("sha256", key).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(expect, s.replace(/=+$/, ""))) return { ok: false, reason: "bad signature" };
  let c: QstashClaims;
  try {
    c = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed JWT claims" };
  }
  if (c.iss !== "Upstash") return { ok: false, reason: "bad issuer" };
  if (typeof c.exp !== "number" || c.exp < nowSec - 5) return { ok: false, reason: "expired" };
  if (typeof c.nbf === "number" && c.nbf > nowSec + 5) return { ok: false, reason: "not yet valid" };
  try {
    if (new URL(c.sub ?? "").pathname.replace(/\/+$/, "") !== new URL(reqUrl).pathname.replace(/\/+$/, "")) return { ok: false, reason: "wrong destination" };
  } catch {
    return { ok: false, reason: "bad subject" };
  }
  const bodyHash = createHash("sha256").update(rawBody).digest("base64url");
  if ((c.body ?? "").replace(/=+$/, "") !== bodyHash) return { ok: false, reason: "body hash mismatch" };
  return { ok: true, jti: typeof c.jti === "string" ? c.jti.slice(0, 128) : null };
}

function hostIsLocal(req: Request): boolean {
  const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/** True when some scheduler credential is configured on this server. */
export function schedulerConfigured(): boolean {
  return !!(process.env.CRON_SECRET || process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_NEXT_SIGNING_KEY);
}

export function verifySchedulerRequest(req: Request, rawBody: string): SchedulerAuth {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (secret && auth && safeEqual(auth, `Bearer ${secret}`)) {
    return { ok: true, via: "cron-secret", executionId: req.headers.get("ce-id")?.slice(0, 128) ?? null };
  }
  const sig = req.headers.get("upstash-signature");
  if (sig) {
    const keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].filter((k): k is string => !!k);
    if (!keys.length) return { ok: false, reason: "QStash signing keys not configured" };
    let last = "invalid QStash signature";
    for (const key of keys) {
      const v = verifyQstashJwt(sig, key, rawBody, req.url);
      if (v.ok) return { ok: true, via: "qstash", executionId: v.jti };
      last = `invalid QStash signature (${v.reason})`;
    }
    return { ok: false, reason: last };
  }
  if (!schedulerConfigured() && process.env.NODE_ENV === "development" && hostIsLocal(req)) {
    return { ok: true, via: "dev-open", executionId: null };
  }
  return { ok: false, reason: secret || schedulerConfigured() ? "unauthorized" : "unauthorized (CRON_SECRET not configured on server)" };
}
