import { type Address, type Hex, getAddress, isAddress, isHex } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { CORS_HEADERS, json } from "@/lib/api";

/**
 * x402 dual-stack resource server for Base USDC, "exact" scheme (EIP-3009 transferWithAuthorization).
 *  - v2 (canonical, @x402/* 2.x): 402 carries base64 `PAYMENT-REQUIRED` header; client retries with
 *    `PAYMENT-SIGNATURE`; server answers `PAYMENT-RESPONSE`. Network id is CAIP-2 `eip155:8453`.
 *  - v1 (legacy x402-fetch/x402-axios 1.x, x402-mcp): 402 JSON body `{x402Version:1, accepts}`; client
 *    retries with `X-PAYMENT`; server answers `X-PAYMENT-RESPONSE`. Network id is `base`.
 * One 402 serves both: v2 in the header, v1 in the body (v2 clients read the header first).
 * Signatures are verified by the facilitator (/verify supports EOA + ERC-1271/6492 smart wallets) and the
 * payment is settled onchain BEFORE the verdict is returned (see src/app/api/v1/guard/route.ts).
 */

export const NETWORK_V2 = "eip155:8453" as const;
export const NETWORK_V1 = "base" as const;
/** Base USDC EIP-712 domain. Verified live 2026-11-07: name()="USD Coin", version()="2", DOMAIN_SEPARATOR matches. */
export const USDC_EIP712 = { name: "USD Coin", version: "2" } as const;
const MAX_HEADER_CHARS = 16_384; // Vercel rejects any single request header > 16 KB anyway

/**
 * CORS for x402 endpoints. Browsers must be allowed to SEND `PAYMENT-SIGNATURE` / `X-PAYMENT` (and the
 * `Access-Control-Expose-Headers` request header @x402/fetch adds on the paid retry) and to READ
 * `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`. Spread over the shared CORS_HEADERS.
 */
export const X402_CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export interface X402Config {
  /** Base address receiving USDC (X402_RECEIVER_ADDRESS); null = paid tier disabled on this deployment. */
  receiver: Address | null;
  /** Price in USDC base units (6 decimals), decimal string. */
  priceAtomic: string;
  /** Authorization validity window offered to clients (seconds). */
  maxTimeoutSeconds: number;
  asset: Address;
  network: typeof NETWORK_V2;
}

export function x402Config(): X402Config {
  const receiver = process.env.X402_RECEIVER_ADDRESS?.trim();
  const price = process.env.X402_PRICE_USDC_ATOMIC?.trim() || "10000";
  const timeout = Number(process.env.X402_MAX_TIMEOUT_SECONDS || 300);
  return {
    receiver: receiver && isAddress(receiver, { strict: false }) ? getAddress(receiver.toLowerCase()) : null,
    priceAtomic: /^\d{1,30}$/.test(price) && BigInt(price) > 0n ? BigInt(price).toString() : "10000",
    maxTimeoutSeconds: Number.isInteger(timeout) && timeout >= 60 && timeout <= 3600 ? timeout : 300,
    asset: CONTRACTS.base.usdc,
    network: NETWORK_V2,
  };
}

// ---------------------------------------------------------------- wire types
export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}
export interface RequirementsV2 {
  scheme: "exact";
  network: typeof NETWORK_V2;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}
export interface RequirementsV1 {
  scheme: "exact";
  network: typeof NETWORK_V1;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: Record<string, unknown>;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: { name: string; version: string };
}
export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: RequirementsV2[];
  extensions?: Record<string, unknown>;
}
export interface PaymentRequiredV1 {
  x402Version: 1;
  error?: string;
  accepts: RequirementsV1[];
}
export interface PaymentRequiredPair {
  v2: PaymentRequiredV2;
  v1: PaymentRequiredV1;
}
export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}
export interface ExactEvmPayload {
  signature: Hex;
  authorization: Eip3009Authorization;
}
export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: RequirementsV2;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}
export interface PaymentPayloadV1 {
  x402Version: 1;
  scheme: "exact";
  network: typeof NETWORK_V1;
  payload: ExactEvmPayload;
}
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
}
export type ParsedPayment =
  | { version: 2; payload: PaymentPayloadV2; requirements: RequirementsV2; auth: Eip3009Authorization; payer: Address }
  | { version: 1; payload: PaymentPayloadV1; requirements: RequirementsV1; auth: Eip3009Authorization; payer: Address };

// ---------------------------------------------------------------- discovery metadata (x402 Bazaar)
export const GUARD_DESCRIPTION =
  "Pre-trade safety verdict (ALLOW/WARN/BLOCK + 0-100 risk score) for any token, pool, wallet or Vibestarter escrow on Base (8453) or Robinhood Chain (4663): live bytecode + EIP-1967 proxy X-ray, owner posture, AMM exit stress test and LayerZero OFT bridge parity, read from mainnet RPCs. Call before an agent swaps.";

export function guardResource(origin: string): ResourceInfo {
  return {
    url: `${origin}/api/v1/guard?mode=full`,
    description: GUARD_DESCRIPTION,
    mimeType: "application/json",
    serviceName: "Kestrel Sentinel", // <= 32 printable ASCII (Bazaar soft-drop rule)
    tags: ["security", "token-risk", "pre-trade", "base", "robinhood-chain"], // <= 5 tags, each <= 32 ASCII
    iconUrl: `${origin}/apple-icon`, // app/apple-icon.tsx -> 180x180 image/png (Bazaar: PNG/JPG/WebP/GIF, no SVG, public host)
  };
}

/** Illustrative response shape for agents (labelled documentation example, like an OpenAPI example; never shown as live data). Kept small: v2 clients echo it inside PAYMENT-SIGNATURE. */
const OUTPUT_EXAMPLE = {
  verdict: "WARN",
  riskScore: 41,
  band: "ELEVATED",
  tier: "full",
  chainId: 8453,
  reasons: [{ severity: "warn", title: "Upgradeable EIP-1967 proxy", points: 12 }],
  payment: { transaction: "0x<settlement tx hash>", network: NETWORK_V2 },
};

export function guardBazaarExtension(): Record<string, unknown> {
  return {
    bazaar: {
      info: {
        input: { type: "http", method: "GET", queryParams: { address: CONTRACTS.base.vibesToken, chainId: "8453", mode: "full" } },
        output: { type: "json", example: OUTPUT_EXAMPLE },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["GET"] },
              queryParams: {
                type: "object",
                properties: {
                  address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Token, pool, wallet or Vibestarter escrow address" },
                  chainId: { type: "string", enum: ["8453", "4663"], description: "8453 Base (default) or 4663 Robinhood Chain" },
                  mode: { type: "string", const: "full", description: "Paid tier (free tier: mode=preview)" },
                },
                required: ["address", "mode"],
                additionalProperties: false,
              },
            },
            required: ["type", "method"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: {
              type: { type: "string" },
              example: {
                type: "object",
                properties: {
                  verdict: { type: "string", enum: ["ALLOW", "WARN", "BLOCK"] },
                  riskScore: { type: "integer", minimum: 0, maximum: 100 },
                  band: { type: "string", enum: ["NOMINAL", "ELEVATED", "CRITICAL"] },
                },
                required: ["verdict", "riskScore", "band"],
              },
            },
            required: ["type"],
          },
        },
        required: ["input"],
      },
    },
  };
}

/** v1 discovery lives in accepts[].outputSchema (facilitators may synthesize extensions.bazaar from it). */
const OUTPUT_SCHEMA_V1 = {
  input: {
    type: "http",
    method: "GET",
    discoverable: true,
    queryParams: {
      address: { type: "string", required: true, description: "Token, pool, wallet or escrow address (0x...)" },
      chainId: { type: "string", enum: ["8453", "4663"], description: "8453 Base (default) or 4663 Robinhood Chain" },
      mode: { type: "string", enum: ["full"], required: true },
    },
  },
  output: OUTPUT_EXAMPLE,
};

// ---------------------------------------------------------------- 402 builders
/** Both 402 representations for the guard resource, or null when X402_RECEIVER_ADDRESS is unset. */
export function buildPaymentRequired(origin: string, error?: string, cfg: X402Config = x402Config()): PaymentRequiredPair | null {
  if (!cfg.receiver) return null;
  const resource = guardResource(origin);
  const extra = { name: USDC_EIP712.name, version: USDC_EIP712.version };
  const v2: PaymentRequiredV2 = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource,
    accepts: [{ scheme: "exact", network: NETWORK_V2, asset: cfg.asset, amount: cfg.priceAtomic, payTo: cfg.receiver, maxTimeoutSeconds: cfg.maxTimeoutSeconds, extra }],
    extensions: guardBazaarExtension(),
  };
  const v1: PaymentRequiredV1 = {
    x402Version: 1,
    ...(error ? { error } : {}),
    accepts: [
      {
        scheme: "exact",
        network: NETWORK_V1,
        maxAmountRequired: cfg.priceAtomic,
        resource: resource.url,
        description: resource.description,
        mimeType: resource.mimeType,
        outputSchema: OUTPUT_SCHEMA_V1,
        payTo: cfg.receiver,
        maxTimeoutSeconds: cfg.maxTimeoutSeconds,
        asset: cfg.asset,
        extra,
      },
    ],
  };
  return { v2, v1 };
}

/** base64(JSON), UTF-8 safe. */
export function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** Inverse of b64; null for oversize, non-base64 or non-JSON input. */
export function unb64<T>(s: string): T | null {
  if (!s || s.length > MAX_HEADER_CHARS) return null;
  try {
    return JSON.parse(Buffer.from(s.trim(), "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** JSON response carrying the x402 CORS headers (so browsers can read PAYMENT-* headers on every outcome). */
export function x402Json(data: unknown, init: { status?: number; headers?: Record<string, string>; cache?: string } = {}) {
  return json(data, { ...init, headers: { ...X402_CORS_HEADERS, ...(init.headers ?? {}) } });
}

export function x402Error(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return x402Json({ error: message, ...extra }, { status });
}

/**
 * HTTP 402: v2 PaymentRequired in `PAYMENT-REQUIRED` (base64) + v1 PaymentRequired as the JSON body.
 * `extraHeaders` carries a settlement receipt (`PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`) on failed settles.
 */
export function paymentRequiredResponse(origin: string, error: string, extraHeaders: Record<string, string> = {}) {
  const pr = buildPaymentRequired(origin, error);
  if (!pr) return x402Error("x402 paid tier is not configured on this deployment (X402_RECEIVER_ADDRESS unset). Use mode=preview.", 501, { configured: false });
  return x402Json(pr.v1, { status: 402, headers: { "PAYMENT-REQUIRED": b64(pr.v2), ...extraHeaders } });
}

// ---------------------------------------------------------------- parsing + local checks
/** v2 `PAYMENT-SIGNATURE` first, then legacy v1 `X-PAYMENT`. */
export function readPaymentHeader(req: Request): string | null {
  return req.headers.get("payment-signature") || req.headers.get("x-payment");
}

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Decode either header version and bind it to THIS server's requirements.
 * v2 (canonical `paymentRequirementsMatchAccepted`): scheme, network, asset, amount, payTo,
 * maxTimeoutSeconds equal ours and our `extra` is a subset of the client's. v1: scheme + network.
 */
export function parsePayment(header: string, pr: PaymentRequiredPair): ParsedPayment | { error: string } {
  const raw = unb64<unknown>(header);
  if (!isObj(raw)) return { error: "invalid_payload" };
  const exact = raw.payload;
  if (!isObj(exact) || !isObj(exact.authorization) || typeof exact.signature !== "string") return { error: "invalid_payload" };
  const auth = exact.authorization as unknown as Eip3009Authorization;
  if (typeof auth.from !== "string" || typeof auth.to !== "string" || !isAddress(auth.from, { strict: false }) || !isAddress(auth.to, { strict: false })) {
    return { error: "invalid_payload" };
  }
  const payer = getAddress(auth.from.toLowerCase());
  if (raw.x402Version === 2) {
    const req = pr.v2.accepts[0];
    const a = raw.accepted;
    if (!isObj(a) || a.scheme !== "exact") return { error: "unsupported_scheme" };
    if (a.network !== NETWORK_V2) return { error: "invalid_network" };
    const extra = isObj(a.extra) ? a.extra : {};
    if (
      !same(a.asset, req.asset) ||
      !same(a.payTo, req.payTo) ||
      a.amount !== req.amount ||
      Number(a.maxTimeoutSeconds) !== req.maxTimeoutSeconds ||
      extra.name !== req.extra.name ||
      extra.version !== req.extra.version
    ) {
      return { error: "invalid_payment_requirements" };
    }
    return { version: 2, payload: raw as unknown as PaymentPayloadV2, requirements: req, auth, payer };
  }
  if (raw.x402Version === 1) {
    if (raw.scheme !== "exact") return { error: "unsupported_scheme" };
    if (raw.network !== NETWORK_V1) return { error: "invalid_network" };
    return { version: 1, payload: raw as unknown as PaymentPayloadV1, requirements: pr.v1.accepts[0], auth, payer };
  }
  return { error: "invalid_x402_version" };
}

/**
 * Same gates as the reference facilitator (exact value, validAfter <= now, validBefore >= now + 6 s) plus a
 * bounded window (validBefore <= now + maxTimeoutSeconds + 120) so replay-lock state never has to outlive it.
 * Returns an x402 error code, or null when the payload may be sent to the facilitator.
 */
export function localChecks(p: ParsedPayment, nowSec: number = Math.floor(Date.now() / 1000)): string | null {
  const a = p.auth;
  const now = BigInt(nowSec);
  if (typeof a.nonce !== "string" || !isHex(a.nonce) || a.nonce.length !== 66) return "invalid_payload";
  if (![a.value, a.validAfter, a.validBefore].every((x) => typeof x === "string" && /^\d{1,78}$/.test(x))) return "invalid_payload";
  if (!isHex(p.payload.payload.signature) || p.payload.payload.signature.length < 4) return "invalid_exact_evm_payload_signature";
  if (!same(a.to, p.requirements.payTo)) return "invalid_exact_evm_payload_recipient_mismatch";
  const required = p.version === 2 ? p.requirements.amount : p.requirements.maxAmountRequired;
  if (BigInt(a.value) !== BigInt(required)) return "invalid_exact_evm_payload_authorization_value_mismatch";
  if (BigInt(a.validAfter) > now) return "invalid_exact_evm_payload_authorization_valid_after";
  if (BigInt(a.validBefore) < now + 6n) return "invalid_exact_evm_payload_authorization_valid_before";
  if (BigInt(a.validBefore) > now + BigInt(p.requirements.maxTimeoutSeconds) + 120n) return "authorization_window_too_long";
  return null;
}

/** Receipt header matching the payer's protocol version. */
export function receiptHeaders(version: 1 | 2, s: SettleResponse): Record<string, string> {
  return version === 2 ? { "PAYMENT-RESPONSE": b64(s) } : { "X-PAYMENT-RESPONSE": b64(s) };
}

/** Replay-lock key: EIP-3009 nonces are scoped per authorizer (USDC.authorizationState(authorizer, nonce)). */
export function authorizationKey(p: ParsedPayment): string {
  return `x402:auth:${p.payer.toLowerCase()}:${p.auth.nonce.toLowerCase()}`;
}
