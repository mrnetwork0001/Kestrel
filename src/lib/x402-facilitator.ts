import { type Hex, parseAbiItem } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { USDC_EIP3009_ABI } from "@/lib/abis";
import { baseLogsClient, basePublicClient } from "@/lib/rpc";
import { NETWORK_V1, NETWORK_V2, type ParsedPayment, type ResourceInfo, type SettleResponse } from "@/lib/x402";

/**
 * Facilitator client (x402 /verify + /settle) for Base mainnet USDC.
 *  - cdp:    https://api.cdp.coinbase.com/platform/v2/x402 — Bearer JWT from a CDP Secret API Key.
 *            1,000 settles/month free then $0.001; gas sponsored; KYT/OFAC; feeds the CDP x402 Bazaar.
 *  - payai:  https://facilitator.payai.network — keyless free tier (1,000 credits; Base EIP-3009 settle
 *            = 1.97 credits ~ $0.00197 on 2026-11-07); optional Ed25519 JWT for paid credits.
 *  - custom: X402_FACILITATOR_URL (no auth).
 * Both CDP and PayAI list x402 v1 `exact/base` and v2 `exact/eip155:8453`.
 * Selection (X402_FACILITATOR): auto (default) = CDP when CDP_API_KEY_ID + CDP_API_KEY_SECRET are set, else PayAI.
 */
export type FacilitatorKind = "cdp" | "payai" | "custom";
export interface Facilitator {
  kind: FacilitatorKind;
  url: string;
  authHeaders(op: "verify" | "settle"): Promise<Record<string, string>>;
}

const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";

export function getFacilitator(): Facilitator | null {
  const pref = (process.env.X402_FACILITATOR || "auto").trim().toLowerCase();
  const cdpId = process.env.CDP_API_KEY_ID?.trim();
  const cdpSecret = process.env.CDP_API_KEY_SECRET?.replace(/\\n/g, "\n").trim();
  if (pref === "cdp" || (pref === "auto" && cdpId && cdpSecret)) {
    if (!cdpId || !cdpSecret) return null;
    return { kind: "cdp", url: CDP_URL, authHeaders: (op) => cdpAuth(op, cdpId, cdpSecret) };
  }
  if (pref === "payai" || pref === "auto") return { kind: "payai", url: PAYAI_URL, authHeaders: payaiAuth };
  const custom = process.env.X402_FACILITATOR_URL?.trim();
  if (!custom || !/^https?:\/\//i.test(custom)) return null;
  return { kind: "custom", url: custom.replace(/\/+$/, ""), authHeaders: async () => ({}) };
}

/** Public, secret-free description of the active facilitator (for /agents and OpenAPI). */
export function facilitatorInfo(): { kind: FacilitatorKind; url: string; auth: "cdp-jwt" | "payai-jwt" | "keyless" } | null {
  const f = getFacilitator();
  if (!f) return null;
  const auth = f.kind === "cdp" ? "cdp-jwt" : f.kind === "payai" && process.env.PAYAI_API_KEY_ID && process.env.PAYAI_API_KEY_SECRET ? "payai-jwt" : "keyless";
  return { kind: f.kind, url: f.url, auth };
}

async function cdpAuth(op: "verify" | "settle", apiKeyId: string, apiKeySecret: string) {
  // Official signer (Ed25519 base64 secret or legacy PEM EC key). Installed via wagmi -> @base-org/account
  // -> @coinbase/cdp-sdk; has no @x402/* imports, so next.config's IgnorePlugin does not affect it.
  const { generateJwt } = await import("@coinbase/cdp-sdk/auth");
  const jwt = await generateJwt({ apiKeyId, apiKeySecret, requestMethod: "POST", requestHost: "api.cdp.coinbase.com", requestPath: `/platform/v2/x402/${op}`, expiresIn: 120 });
  return { Authorization: `Bearer ${jwt}` };
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Port of @payai/facilitator@2.4.6 generatePayAIApiKeyJwt (EdDSA over a PKCS#8 base64 secret). Free tier: no headers. */
async function payaiAuth(): Promise<Record<string, string>> {
  const id = process.env.PAYAI_API_KEY_ID?.trim();
  const secret = process.env.PAYAI_API_KEY_SECRET?.trim();
  if (!id || !secret) return {};
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const message = `${enc({ alg: "EdDSA", typ: "JWT", kid: id })}.${enc({ sub: id, iss: "payai-merchant", iat: now, exp: now + 120, jti: crypto.randomUUID() })}`;
  const der = Buffer.from(secret.startsWith("payai_sk_") ? secret.slice(9) : secret, "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message)));
  return { Authorization: `Bearer ${message}.${b64url(sig)}` };
}

export class FacilitatorUnavailable extends Error {}

export interface CanonicalDiscovery {
  resource: ResourceInfo;
  extensions: Record<string, unknown>;
}

/**
 * Body sent to /verify and /settle. For v2 the server re-stamps its own canonical `resource` and
 * `extensions.bazaar` (unsigned envelope fields: the EIP-3009 signature covers only the authorization) so
 * every settle carries the discovery metadata the Bazaar indexes, even if the client did not echo it.
 */
export function facilitatorRequestBody(p: ParsedPayment, canonical?: CanonicalDiscovery) {
  if (p.version === 2) {
    const paymentPayload = canonical ? { ...p.payload, resource: canonical.resource, extensions: { ...(p.payload.extensions ?? {}), ...canonical.extensions } } : p.payload;
    return { x402Version: 2, paymentPayload, paymentRequirements: p.requirements };
  }
  return { x402Version: 1, paymentPayload: p.payload, paymentRequirements: p.requirements };
}

async function post(f: Facilitator, op: "verify" | "settle", body: unknown, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(`${f.url}/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await f.authHeaders(op)) },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null };
  } catch (e) {
    throw new FacilitatorUnavailable(e instanceof Error ? e.message : String(e));
  }
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

/** 4xx with {isValid:false} is a normal "invalid" verdict; anything without isValid is a facilitator fault. */
export async function facilitatorVerify(f: Facilitator, p: ParsedPayment): Promise<VerifyResponse> {
  const { status, data } = await post(f, "verify", facilitatorRequestBody(p), 15_000);
  if (data && typeof data.isValid === "boolean") {
    return {
      isValid: data.isValid,
      invalidReason: typeof data.invalidReason === "string" ? data.invalidReason.slice(0, 120) : undefined,
      invalidMessage: typeof data.invalidMessage === "string" ? data.invalidMessage.slice(0, 300) : undefined,
      payer: typeof data.payer === "string" ? data.payer : undefined,
    };
  }
  throw new FacilitatorUnavailable(`verify HTTP ${status}`);
}

const networkOf = (p: ParsedPayment) => (p.version === 2 ? NETWORK_V2 : NETWORK_V1);
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

async function settleOnce(f: Facilitator, p: ParsedPayment, canonical?: CanonicalDiscovery): Promise<SettleResponse | null> {
  try {
    const { data } = await post(f, "settle", facilitatorRequestBody(p, canonical), 30_000);
    // CDP signals `settlement_pending` as HTTP 500 + {success:false, errorReason, transaction}; still parse it.
    if (data && typeof data.success === "boolean") {
      return {
        success: data.success,
        transaction: typeof data.transaction === "string" && TX_RE.test(data.transaction) ? data.transaction : "",
        network: typeof data.network === "string" ? data.network : networkOf(p),
        payer: typeof data.payer === "string" ? data.payer : p.payer,
        ...(typeof data.errorReason === "string" ? { errorReason: data.errorReason.slice(0, 120) } : {}),
        ...(typeof data.errorMessage === "string" ? { errorMessage: data.errorMessage.slice(0, 300) } : {}),
      };
    }
    return null;
  } catch {
    return null; // timeout/network: indeterminate; the facilitator may still broadcast
  }
}

/** USDC `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` (EIP-3009). */
export const AUTHORIZATION_USED_EVENT = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** ~1 h of Base blocks at 200 ms (Base moved to 200 ms blocks on 2026-11-05); inside publicnode's 50k getLogs cap. */
const LOOKBACK_BLOCKS = 18_000n;

/** Onchain `USDC.authorizationState(payer, nonce)`: true once the authorization was used OR canceled. */
export async function authorizationUsedOnchain(p: ParsedPayment): Promise<boolean> {
  return basePublicClient
    .readContract({ address: CONTRACTS.base.usdc, abi: USDC_EIP3009_ABI, functionName: "authorizationState", args: [p.payer, p.auth.nonce] })
    .catch(() => false);
}

/**
 * Did THIS authorization move funds onchain? Requires a successful tx with USDC `AuthorizationUsed(payer, nonce)`
 * (not Canceled) AND the exact `Transfer(payer -> payTo, value)`. Returns the settlement tx hash or null.
 */
export async function findSettlementOnchain(p: ParsedPayment, hintTx?: string, receiptTimeoutMs = 12_000): Promise<Hex | null> {
  const usdc = CONTRACTS.base.usdc.toLowerCase();
  const nonce = p.auth.nonce.toLowerCase();
  const matches = async (hash: Hex) => {
    const rc = await basePublicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs }).catch(() => null);
    if (!rc || rc.status !== "success") return false;
    const logs = rc.logs.filter((l) => l.address.toLowerCase() === usdc);
    const used = logs.some((l) => l.topics[0] === AUTHORIZATION_USED_TOPIC && l.topics[2]?.toLowerCase() === nonce && l.topics[1]?.toLowerCase().endsWith(p.payer.slice(2).toLowerCase()));
    const moved = logs.some(
      (l) =>
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics[1]?.toLowerCase().endsWith(p.payer.slice(2).toLowerCase()) &&
        l.topics[2]?.toLowerCase().endsWith(p.auth.to.slice(2).toLowerCase()) &&
        l.data !== "0x" &&
        BigInt(l.data) === BigInt(p.auth.value)
    );
    return used && moved;
  };
  if (hintTx && TX_RE.test(hintTx) && (await matches(hintTx as Hex))) return hintTx as Hex;
  if (!(await authorizationUsedOnchain(p))) return null;
  const head = await baseLogsClient.getBlockNumber().catch(() => null);
  if (head === null) return null;
  const logs = await baseLogsClient
    .getLogs({ address: CONTRACTS.base.usdc, event: AUTHORIZATION_USED_EVENT, args: { authorizer: p.payer, nonce: p.auth.nonce }, fromBlock: head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n, toBlock: head })
    .catch(() => []);
  const tx = logs[0]?.transactionHash;
  return tx && (await matches(tx)) ? tx : null;
}

/**
 * Settle with the CDP-documented reconciliation: on `settlement_pending` resend the identical request once;
 * if still pending / timed out / unknown, ask the chain (authorizationState + AuthorizationUsed log + Transfer).
 * Never asks the buyer for a second authorization (that is how double charges happen). No cross-facilitator
 * failover: a timed-out settle may still land, and a second broadcaster only adds a race.
 */
export async function settleAndReconcile(f: Facilitator, p: ParsedPayment, canonical?: CanonicalDiscovery): Promise<SettleResponse & { reconciledOnchain?: boolean }> {
  let r = await settleOnce(f, p, canonical);
  if (r && !r.success && r.errorReason === "settlement_pending" && r.transaction) r = (await settleOnce(f, p, canonical)) ?? r;
  if (r?.success && r.transaction) return r;
  const indeterminate = !r || r.success || r.errorReason === "settlement_pending" || r.errorReason === "unexpected_settle_error";
  if (indeterminate) {
    const tx = await findSettlementOnchain(p, r?.transaction);
    if (tx) return { success: true, transaction: tx, network: networkOf(p), payer: p.payer, reconciledOnchain: true };
  }
  if (r && !r.success) return r;
  return { success: false, errorReason: r?.success ? "settlement_unconfirmed" : "facilitator_unreachable", transaction: "", network: networkOf(p), payer: p.payer };
}
