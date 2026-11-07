import { NextResponse } from "next/server";
import { type Address, zeroAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { rateLimited } from "@/lib/api";
import { cached } from "@/lib/cache";
import { errMsg, parseAddress } from "@/lib/engine/chain-utils";
import { guardVerdict } from "@/lib/engine/guard";
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
import { authorizationUsedOnchain, facilitatorVerify, findSettlementOnchain, getFacilitator, settleAndReconcile } from "@/lib/x402-facilitator";

export const runtime = "nodejs";
export const maxDuration = 60;

type LockState = { state: "processing" | "pending" | "settled" | "failed"; tx?: string; reason?: string; at: number };
type GuardResult = Awaited<ReturnType<typeof guardVerdict>>;
const DAY = 86_400;
const SUPPORTED_CHAINS = "8453 (Base) or 4663 (Robinhood Chain)";

/** Strict chain id: absent -> Base; 8453 / 4663 (number, decimal or 0x string) accepted; anything else rejected. */
function parseChainId(input: unknown): ChainId | null {
  if (input === undefined || input === null || input === "") return 8453;
  if (typeof input !== "number" && typeof input !== "string") return null;
  const s = String(input).trim();
  if (!/^(\d{1,10}|0x[0-9a-fA-F]{1,8})$/.test(s)) return null;
  const n = Number(s);
  return n === 8453 ? 8453 : n === 4663 ? 4663 : null;
}

/**
 * Pre-Trade Security Gate for AI agents.
 *  GET  /api/v1/guard?address=0x…&chainId=8453[&mode=preview|full]
 *  POST /api/v1/guard { address, chainId, mode }
 * mode=preview (default) is free. mode=full is an x402 resource (v2 PAYMENT-SIGNATURE or v1 X-PAYMENT,
 * Base USDC EIP-3009 "exact"). Flow = x402 "authorization": verify -> run scan -> settle -> respond. The verdict
 * is returned only after the facilitator settled onchain; each EIP-3009 authorization yields at most one 200.
 */
async function handle(req: Request, input: { address?: unknown; chainId?: unknown; mode?: unknown }) {
  const rawMode = input.mode;
  if (rawMode !== undefined && rawMode !== null && rawMode !== "" && rawMode !== "preview" && rawMode !== "full") {
    return x402Error("`mode` must be \"preview\" (free) or \"full\" (x402 paid).", 400);
  }
  const mode = rawMode === "full" ? "full" : "preview";
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
      return x402Json(await cached(`guard:preview:${chainId}:${address.toLowerCase()}`, 30, () => guardVerdict(chainId, address, "preview")));
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
  const bad = localChecks(p);
  if (bad) return paymentRequiredResponse(origin, bad);

  // Replay lock: one in-flight/settled outcome per (payer, nonce). SET NX EX is atomic on Upstash.
  const key = authorizationKey(p);
  const ttl = cfg.maxTimeoutSeconds + 180; // an authorization cannot outlive validBefore (bounded in localChecks)
  let claimed: boolean;
  try {
    claimed = await kvSet(key, JSON.stringify({ state: "processing", at: Date.now() } satisfies LockState), { nx: true, ex: ttl });
  } catch {
    return x402Error("Payment ledger unavailable; retry shortly. Your payment was not used.", 503);
  }
  if (!claimed) return handleSeenAuthorization(origin, p, key, chainId, address);

  // Sequential replay after the lock expired (or a payment settled elsewhere): the chain is the source of truth.
  if (await authorizationUsedOnchain(p)) {
    // Orphan recovery: this authorization already paid Kestrel onchain but no verdict was ever delivered
    // (e.g. the invocation timed out right after settling). Deliver once; deliver() enforces one 200 per tx.
    const tx = await findSettlementOnchain(p, undefined, 6_000);
    if (tx && !(await kvGet(`x402:delivered:${tx.toLowerCase()}`))) return scanAndDeliver(origin, p, tx, key, chainId, address);
    await kvSetJson(key, { state: "failed", reason: "authorization_used", at: Date.now() } satisfies LockState, { ex: ttl }).catch(() => undefined);
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
    result = await guardVerdict(chainId, address, "full");
  } catch (e) {
    await kvDel(key).catch(() => 0); // nothing settled -> the same signed payment can be retried
    return x402Error(`Guard scan failed: ${errMsg(e)}. Payment NOT settled; retry with the same payment header.`, 502);
  }

  const s = await settleAndReconcile(facilitator, p, { resource: pr.v2.resource, extensions: pr.v2.extensions ?? {} });
  if (!s.success) {
    const pending = s.errorReason === "settlement_pending" && Boolean(s.transaction);
    await kvSetJson(key, { state: pending ? "pending" : "failed", tx: s.transaction || undefined, reason: s.errorReason, at: Date.now() } satisfies LockState, {
      ex: pending ? DAY : ttl,
    }).catch(() => undefined);
    return paymentRequiredResponse(origin, s.errorReason ?? "settlement_failed", receiptHeaders(p.version, s));
  }
  return deliver(origin, p, s, key, result, chainId, address);
}

/** Same authorization presented again: never deliver twice; finish a `settlement_pending` (or an orphaned stale lock) exactly once. */
async function handleSeenAuthorization(origin: string, p: ParsedPayment, key: string, chainId: ChainId, address: Address) {
  const prev = await kvGetJson<LockState>(key);
  // A "processing" lock older than maxDuration (60 s) belongs to an invocation that no longer exists.
  const stale = prev?.state === "processing" && Date.now() - prev.at > 90_000;
  if (prev?.state !== "pending" && !stale) return paymentRequiredResponse(origin, prev?.state === "processing" ? "payment_in_flight" : "payment_already_used");
  const tx = await findSettlementOnchain(p, prev?.tx, 6_000);
  if (!tx) {
    const receipt =
      prev?.state === "pending"
        ? receiptHeaders(p.version, { success: false, errorReason: "settlement_pending", transaction: prev.tx ?? "", network: p.requirements.network, payer: p.payer })
        : {};
    return paymentRequiredResponse(origin, prev?.state === "pending" ? "settlement_pending" : "payment_in_flight", receipt);
  }
  if (await kvGet(`x402:delivered:${tx.toLowerCase()}`)) return paymentRequiredResponse(origin, "payment_already_used");
  return scanAndDeliver(origin, p, tx, key, chainId, address);
}

async function scanAndDeliver(origin: string, p: ParsedPayment, tx: string, key: string, chainId: ChainId, address: Address) {
  let result: GuardResult;
  try {
    result = await guardVerdict(chainId, address, "full");
  } catch (e) {
    await kvSetJson(key, { state: "pending", tx, at: Date.now() } satisfies LockState, { ex: DAY }).catch(() => undefined);
    return x402Error(`Guard scan failed: ${errMsg(e)}. Payment is settled (${tx}); retry with the same payment header to receive the verdict.`, 502);
  }
  return deliver(origin, p, { success: true, transaction: tx, network: p.requirements.network, payer: p.payer }, key, result, chainId, address);
}

async function deliver(origin: string, p: ParsedPayment, s: SettleResponse, key: string, result: GuardResult, chainId: ChainId, address: Address) {
  const tx = s.transaction.toLowerCase();
  // Second guard: one 200 per settlement tx, even if a facilitator answers duplicate settles idempotently.
  // A KV error here fails open (the payment IS settled onchain and the (payer, nonce) lock already stopped replays).
  const first = await kvSet(`x402:delivered:${tx}`, "1", { nx: true, ex: 90 * DAY }).catch(() => true);
  if (!first) return paymentRequiredResponse(origin, "payment_already_used");
  const entry = { tx: s.transaction, payer: p.payer, amountAtomic: p.auth.value, network: s.network, x402Version: p.version, target: address, chainId, at: new Date().toISOString() };
  await Promise.all([
    kvSetJson(key, { state: "settled", tx: s.transaction, at: Date.now() } satisfies LockState, { ex: 30 * DAY }),
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
  return x402Json({ ...result, payment }, { headers: { ...receiptHeaders(p.version, s), "Cache-Control": "private, no-store" } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  return handle(req, { address: u.searchParams.get("address"), chainId: u.searchParams.get("chainId"), mode: u.searchParams.get("mode") });
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
  return handle(req, { address: b.address, chainId: b.chainId, mode: b.mode });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: X402_CORS_HEADERS });
}
