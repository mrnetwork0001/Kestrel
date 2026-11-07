import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { type Address, zeroAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { rateLimited } from "@/lib/api";
import { errMsg, parseAddress, parseChainId } from "@/lib/engine/chain-utils";
import { cachedGuardVerdict, GUARD_RETRY_AFTER_SEC, type GuardIntent, guardVerdict, type GuardVerdictResult, parseGuardIntent } from "@/lib/engine/guard";
import type { ChainId } from "@/lib/engine/types";
import { kvDel, kvGet, kvGetJson, kvMode, kvSAdd, kvSet, kvSetJson } from "@/lib/kv";
import { siteUrl } from "@/lib/site";
import {
  authorizationKey,
  buildPaymentRequired,
  localChecks,
  type ParsedPayment,
  parsePayment,
  paymentRequiredResponse,
  readPaymentHeader,
  receiptHeaders,
  type SettleResponse,
  X402_CORS_HEADERS,
  x402Config,
  x402Error,
  x402Json,
} from "@/lib/x402";
import {
  authorizationStateStrict,
  authorizationUsedOnchain,
  facilitatorVerify,
  findSettlementOnchain,
  getFacilitator,
  NON_DEFINITIVE_SETTLE_ERRORS,
  settleAndReconcile,
} from "@/lib/x402-facilitator";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Binding of a replay lock to the ORIGINAL signed authorization and request. Every recovery path (pending,
 * stale-processing, settled re-delivery, expired-header retry) requires an exact match, so nobody can collect a
 * verdict for a different target with someone else's (payer, nonce) — the facilitator is not consulted there.
 */
type Binding = { sig: string; va: string; vb: string; req: string };
type LockState = { state: "processing" | "pending" | "settled" | "failed"; tx?: string; reason?: string; at: number } & Partial<Binding>;
/** A delivered paid response, replayed verbatim to the same bound request (idempotent retries after a dropped connection). */
type StoredDelivery = { body: unknown; headers: Record<string, string> } & Binding;
type GuardResult = GuardVerdictResult;
const DAY = 86_400;
const SUPPORTED_CHAINS = "8453 (Base) or 4663 (Robinhood Chain)";
const PENDING_RETRY_SEC = 15;

function bindingOf(p: ParsedPayment, chainId: ChainId, address: Address, intent: GuardIntent): Binding {
  return {
    sig: createHash("sha256").update(p.payload.payload.signature.toLowerCase()).digest("hex"),
    va: p.auth.validAfter,
    vb: p.auth.validBefore,
    req: `${chainId}:${address.toLowerCase()}:${intent}`,
  };
}

function sameBinding(a: Partial<Binding> | null | undefined, b: Binding): boolean {
  return !!a && !!a.sig && a.sig === b.sig && a.va === b.va && a.vb === b.vb && a.req === b.req;
}

/**
 * Settlement not final yet (pending broadcast, facilitator timeout/5xx, unconfirmed): 202 + receipt telling the
 * client to retry with the SAME header. Deliberately no fresh PAYMENT-REQUIRED challenge (that reads as "pay again").
 */
function pendingResponse(p: ParsedPayment, tx: string | undefined, reason: string | undefined) {
  const s: SettleResponse = { success: false, errorReason: "settlement_pending", transaction: tx ?? "", network: p.requirements.network, payer: p.payer };
  return x402Json(
    {
      status: "settlement_pending",
      retryWithSameHeader: true,
      retryAfterSec: PENDING_RETRY_SEC,
      transaction: tx || null,
      reason: reason ?? "settlement_pending",
      detail: "Settlement is not final yet. Retry with the SAME payment header (it stays valid for recovery even after validBefore). Do NOT sign a new payment.",
    },
    { status: 202, headers: { ...receiptHeaders(p.version, s), "Retry-After": String(PENDING_RETRY_SEC), "Cache-Control": "private, no-store" } }
  );
}

/**
 * Free-tier response for a verdict. A scan that could not classify the address at all (`scanError`) → HTTP 503
 * with Retry-After; a partially degraded verdict → 200 WARN with `status: "degraded"` + `retryAfterSec`.
 * Neither is ever ALLOW, and neither is cached (cachedGuardVerdict).
 */
function verdictResponse(result: GuardResult) {
  if (result.status === "degraded") {
    const unavailable = "scanError" in result && Boolean(result.scanError);
    return x402Json(result, { status: unavailable ? 503 : 200, headers: { "Retry-After": String(GUARD_RETRY_AFTER_SEC), "X-Kestrel-Guard-Status": "degraded" } });
  }
  return x402Json(result, { headers: { "X-Kestrel-Guard-Status": "complete" } });
}

/**
 * Pre-Trade Security Gate for AI agents.
 *  GET  /api/v1/guard?address=0x…&chainId=8453[&mode=preview|full][&intent=trade|counterparty]
 *  POST /api/v1/guard { address, chainId, mode, intent }
 * mode=preview (default) is free. mode=full is an x402 resource (v2 PAYMENT-SIGNATURE or v1 X-PAYMENT,
 * Base USDC EIP-3009 "exact"). Flow = x402 "authorization": verify -> run scan -> settle -> respond. The verdict
 * is returned only after the facilitator settled onchain; each EIP-3009 authorization yields at most one 200.
 */
async function handle(req: Request, input: { address?: unknown; chainId?: unknown; mode?: unknown; intent?: unknown }) {
  const rawMode = input.mode;
  if (rawMode !== undefined && rawMode !== null && rawMode !== "" && rawMode !== "preview" && rawMode !== "full") {
    return x402Error("`mode` must be \"preview\" (free) or \"full\" (x402 paid).", 400);
  }
  const mode = rawMode === "full" ? "full" : "preview";
  const intent = parseGuardIntent(input.intent);
  if (!intent) return x402Error("`intent` must be \"trade\" (default: the address is a token/pool you will trade or approve) or \"counterparty\" (a wallet you will send to).", 400);
  const chainId = parseChainId(input.chainId);
  if (!chainId) return x402Error(`Unsupported chainId. Kestrel guards ${SUPPORTED_CHAINS} only.`, 400, { supportedChainIds: [8453, 4663] });
  const hasAddress = input.address !== undefined && input.address !== null && input.address !== "";
  const address = parseAddress(input.address);
  if (hasAddress && !address) return x402Error("`address` must be a valid 0x address (20 bytes, hex).", 400);
  if (address === zeroAddress) return x402Error("The zero address is not a token, pool, wallet or escrow; nothing to guard.", 400);

  if (mode === "preview") {
    if (await rateLimited(req, 60)) return x402Error("Rate limited.", 429);
    if (!address) return x402Error("`address` is required.", 400);
    try {
      return verdictResponse(await cachedGuardVerdict(chainId, address, "preview", { intent }));
    } catch (e) {
      return x402Error(`Guard scan failed: ${errMsg(e)}`, 502);
    }
  }

  // ------------------------------------------------------------------ paid tier (x402)
  const origin = siteUrl(req);
  const cfg = x402Config();
  const pr = buildPaymentRequired(origin, undefined, cfg);
  if (!pr) {
    return x402Error("x402 paid tier is not configured on this deployment: X402_RECEIVER_ADDRESS is unset, so no payment can be accepted. Use mode=preview (free).", 501, {
      configured: false,
    });
  }
  const facilitator = getFacilitator();
  if (!facilitator) {
    return x402Error("x402 facilitator is misconfigured on this deployment (X402_FACILITATOR=cdp needs CDP_API_KEY_ID/SECRET; custom needs X402_FACILITATOR_URL). Use mode=preview.", 501, {
      configured: false,
    });
  }
  if (kvMode() === "memory" && process.env.NODE_ENV === "production" && process.env.X402_ALLOW_MEMORY_LEDGER !== "1") {
    return x402Error("x402 replay ledger (Upstash Redis) is not configured; paid tier disabled to prevent replays. Use mode=preview.", 503);
  }

  const header = readPaymentHeader(req);
  // No payment -> 402 challenge even without params, so Bazaar / CDP validator probes of `${origin}/api/v1/guard?mode=full` see a 402.
  if (!header) return paymentRequiredResponse(origin, "Payment required");
  if (!address) return x402Error("`address` is required. Your payment was not used.", 400);
  if (await rateLimited(req, 120, { route: "guard:paid" })) return x402Error("Rate limited. Your payment was not used.", 429);

  const p = parsePayment(header, pr);
  if ("error" in p) return paymentRequiredResponse(origin, p.error);
  const key = authorizationKey(p);
  const bind = bindingOf(p, chainId, address, intent);
  const bad = localChecks(p);
  if (bad) {
    // An expired header may still collect the verdict it already paid for (pending / stale / settled lock),
    // but only with an exact binding to the original authorization and request.
    if (bad === "invalid_exact_evm_payload_authorization_valid_before") {
      const prev = await kvGetJson<LockState>(key).catch(() => null);
      if (prev && sameBinding(prev, bind)) return handleSeenAuthorization(origin, p, key, bind, prev, chainId, address, intent);
    }
    return paymentRequiredResponse(origin, bad);
  }

  // Replay lock: one in-flight/settled outcome per (payer, nonce). SET NX EX is atomic on Upstash. It lives a day
  // (not just the authorization window) so a crash after settling is recovered through the BOUND lock, never lock-less.
  const ttl = cfg.maxTimeoutSeconds + 180; // definitive failures: an authorization cannot outlive validBefore
  const claimedAt = Date.now();
  let claimed: boolean;
  try {
    claimed = await kvSet(key, JSON.stringify({ state: "processing", at: claimedAt, ...bind } satisfies LockState), { nx: true, ex: DAY });
  } catch {
    return x402Error("Payment ledger unavailable; retry shortly. Your payment was not used.", 503);
  }
  if (!claimed) return handleSeenAuthorization(origin, p, key, bind, null, chainId, address, intent);

  // Already used onchain but no lock of ours exists: nothing binds THIS header to that payment (anyone can read
  // (payer, nonce) and even the signature from the settlement calldata), so never deliver from here.
  if (await authorizationUsedOnchain(p)) {
    await kvSetJson(key, { state: "failed", reason: "authorization_used", at: Date.now(), ...bind } satisfies LockState, { ex: DAY }).catch(() => undefined);
    return paymentRequiredResponse(origin, "payment_already_used");
  }

  try {
    const v = await facilitatorVerify(facilitator, p);
    if (!v.isValid) {
      await kvDel(key).catch(() => 0);
      return paymentRequiredResponse(origin, v.invalidReason ?? "invalid_payment");
    }
  } catch (e) {
    await kvDel(key).catch(() => 0);
    return x402Error(`x402 facilitator unavailable (${errMsg(e)}). Your payment was not used.`, 502);
  }

  let result: GuardResult;
  try {
    result = await guardVerdict(chainId, address, "full", { intent });
  } catch (e) {
    await kvDel(key).catch(() => 0); // nothing settled -> the same signed payment can be retried
    return x402Error(`Guard scan failed: ${errMsg(e)}. Payment NOT settled; retry with the same payment header.`, 502);
  }
  if (result.status === "degraded") {
    // Never charge for an UNKNOWN verdict: nothing settled -> the same signed payment can be retried.
    await kvDel(key).catch(() => 0);
    return x402Error(`Guard scan incomplete (live RPC read failed). Payment NOT settled; retry in ${GUARD_RETRY_AFTER_SEC}s with the same payment header.`, 503, {
      status: "degraded",
      retryAfterSec: GUARD_RETRY_AFTER_SEC,
      verdict: result.verdict,
    });
  }

  const s = await settleAndReconcile(facilitator, p, { resource: pr.v2.resource, extensions: pr.v2.extensions ?? {} });
  if (!s.success) {
    // Anything that may still move funds is PENDING (1 day, same-header retries), never a terminal "failed".
    const nonDefinitive = NON_DEFINITIVE_SETTLE_ERRORS.has(s.errorReason ?? "") || (await authorizationStateStrict(p)) !== false;
    if (nonDefinitive) {
      await kvSetJson(key, { state: "pending", tx: s.transaction || undefined, reason: s.errorReason, at: claimedAt, ...bind } satisfies LockState, { ex: DAY }).catch(() => undefined);
      return pendingResponse(p, s.transaction || undefined, s.errorReason);
    }
    await kvSetJson(key, { state: "failed", tx: s.transaction || undefined, reason: s.errorReason, at: Date.now(), ...bind } satisfies LockState, { ex: ttl }).catch(() => undefined);
    return paymentRequiredResponse(origin, s.errorReason ?? "settlement_failed", receiptHeaders(p.version, s));
  }
  return deliver(origin, p, s, key, bind, result, chainId, address);
}

/** Replays a stored paid response to the SAME bound request (sig hash + validity window + target/chain/intent). */
async function replayDelivered(tx: string, bind: Binding): Promise<Response | null> {
  const stored = await kvGetJson<StoredDelivery>(`x402:resp:${tx.toLowerCase()}`).catch(() => null);
  if (!stored || !sameBinding(stored, bind)) return null;
  return x402Json(stored.body, { headers: { ...stored.headers, "Cache-Control": "private, no-store" } });
}

/**
 * Same authorization presented again: never deliver to a different request; finish a pending settlement (or an
 * orphaned stale lock) once, and replay an already delivered response to the same bound request.
 */
async function handleSeenAuthorization(origin: string, p: ParsedPayment, key: string, bind: Binding, prevIn: LockState | null, chainId: ChainId, address: Address, intent: GuardIntent) {
  const prev = prevIn ?? (await kvGetJson<LockState>(key).catch(() => null));
  if (prev?.state === "settled" && prev.tx && sameBinding(prev, bind)) {
    const again = await replayDelivered(prev.tx, bind);
    if (again) return again;
  }
  // A "processing" lock older than maxDuration (60 s) belongs to an invocation that no longer exists.
  const stale = prev?.state === "processing" && Date.now() - prev.at > 90_000;
  if (prev?.state !== "pending" && !stale) return paymentRequiredResponse(origin, prev?.state === "processing" ? "payment_in_flight" : "payment_already_used");
  // Recovery hands out a PAID verdict without asking the facilitator: exact binding to the original header + request.
  if (!sameBinding(prev, bind)) return paymentRequiredResponse(origin, "payment_already_used");
  const tx = await findSettlementOnchain(p, prev.tx, 6_000, { sinceMs: prev.at });
  if (!tx) {
    // Never settled and it can no longer settle (window over, authorization unused) → definitive: nothing was charged.
    const expired = BigInt(p.auth.validBefore) < BigInt(Math.floor(Date.now() / 1000));
    if (expired && (await authorizationStateStrict(p)) === false) {
      await kvSetJson(key, { ...prev, state: "failed", reason: "authorization_expired_unsettled", at: Date.now() } satisfies LockState, { ex: DAY }).catch(() => undefined);
      return paymentRequiredResponse(origin, "authorization_expired_unsettled");
    }
    return prev.state === "pending" ? pendingResponse(p, prev.tx, prev.reason) : paymentRequiredResponse(origin, "payment_in_flight");
  }
  if (await kvGet(`x402:delivered:${tx.toLowerCase()}`)) return (await replayDelivered(tx, bind)) ?? paymentRequiredResponse(origin, "payment_already_used");
  return scanAndDeliver(origin, p, tx, key, bind, prev.at, chainId, address, intent);
}

async function scanAndDeliver(origin: string, p: ParsedPayment, tx: string, key: string, bind: Binding, since: number, chainId: ChainId, address: Address, intent: GuardIntent) {
  let result: GuardResult;
  try {
    result = await guardVerdict(chainId, address, "full", { intent });
  } catch (e) {
    await kvSetJson(key, { state: "pending", tx, at: since, ...bind } satisfies LockState, { ex: DAY }).catch(() => undefined);
    return x402Error(`Guard scan failed: ${errMsg(e)}. Payment is settled (${tx}); retry with the same payment header to receive the verdict.`, 502);
  }
  if (result.status === "degraded") {
    // Paid but the verdict is UNKNOWN: keep the settlement pending so a retry with the same header delivers once.
    await kvSetJson(key, { state: "pending", tx, at: since, ...bind } satisfies LockState, { ex: DAY }).catch(() => undefined);
    return x402Error(`Guard scan incomplete (live RPC read failed). Payment is settled (${tx}); retry in ${GUARD_RETRY_AFTER_SEC}s with the same payment header to receive the verdict.`, 503, {
      status: "degraded",
      retryAfterSec: GUARD_RETRY_AFTER_SEC,
    });
  }
  return deliver(origin, p, { success: true, transaction: tx, network: p.requirements.network, payer: p.payer }, key, bind, result, chainId, address);
}

async function deliver(origin: string, p: ParsedPayment, s: SettleResponse, key: string, bind: Binding, result: GuardResult, chainId: ChainId, address: Address) {
  const tx = s.transaction.toLowerCase();
  // Second guard: one 200 per settlement tx, even if a facilitator answers duplicate settles idempotently.
  // A KV error here fails open (the payment IS settled onchain and the (payer, nonce) lock already stopped replays).
  const first = await kvSet(`x402:delivered:${tx}`, "1", { nx: true, ex: 90 * DAY }).catch(() => true);
  if (!first) return (await replayDelivered(tx, bind)) ?? paymentRequiredResponse(origin, "payment_already_used");
  const entry = { tx: s.transaction, payer: p.payer, amountAtomic: p.auth.value, network: s.network, x402Version: p.version, target: address, chainId, at: new Date().toISOString() };
  await Promise.all([
    kvSetJson(key, { state: "settled", tx: s.transaction, at: Date.now(), ...bind } satisfies LockState, { ex: 30 * DAY }),
    kvSetJson(`x402:tx:${tx}`, entry, { ex: 90 * DAY }),
    kvSAdd("x402:txs", tx),
  ]).catch(() => undefined); // ledger is best-effort; the onchain revenue scan (/api/x402/revenue) is the source of truth
  const payment = {
    transaction: s.transaction,
    network: s.network,
    payer: p.payer,
    asset: CONTRACTS.base.usdc,
    amountAtomic: p.auth.value,
    x402Version: p.version,
    explorer: `https://basescan.org/tx/${s.transaction}`,
  };
  const body = { ...result, payment };
  const headers = receiptHeaders(p.version, s);
  // Same bound request retrying (dropped connection) gets this exact response again, for a day.
  await kvSetJson(`x402:resp:${tx}`, { body, headers, ...bind } satisfies StoredDelivery, { ex: DAY }).catch(() => undefined);
  return x402Json(body, { headers: { ...headers, "Cache-Control": "private, no-store" } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle(req, { address: u.searchParams.get("address"), chainId: u.searchParams.get("chainId"), mode: u.searchParams.get("mode"), intent: u.searchParams.get("intent") });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return x402Error("Body must be a JSON object: { address, chainId, mode }.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return x402Error("Body must be a JSON object: { address, chainId, mode }.", 400);
  }
  const b = body as Record<string, unknown>;
  return handle(req, { address: b.address, chainId: b.chainId, mode: b.mode, intent: b.intent });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: X402_CORS_HEADERS });
}
