import { type Address, type Hex, getAddress, isAddress, verifyTypedData } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { ERC20_ABI, USDC_EIP3009_ABI } from "@/lib/abis";
import { basePublicClient } from "@/lib/rpc";

/**
 * x402 "exact" scheme on Base USDC (EIP-3009 transferWithAuthorization).
 * Spec: https://github.com/coinbase/x402 — the client retries with an `X-PAYMENT` header
 * containing base64(JSON PaymentPayload). We verify the EIP-712 signature + onchain nonce/balance
 * locally, and settle through a facilitator when X402_FACILITATOR_URL is configured.
 */

export const X402_VERSION = 1;

export function x402Config() {
  const receiver = process.env.X402_RECEIVER_ADDRESS;
  const price = process.env.X402_PRICE_USDC_ATOMIC || "10000";
  return {
    receiver: receiver && isAddress(receiver) ? getAddress(receiver) : null,
    priceAtomic: /^\d+$/.test(price) ? price : "10000",
    facilitator: process.env.X402_FACILITATOR_URL || null,
  };
}

export interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: { name: string; version: string };
}

export function buildRequirements(resource: string): PaymentRequirements | null {
  const cfg = x402Config();
  if (!cfg.receiver) return null;
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: cfg.priceAtomic,
    resource,
    description: "Kestrel full pre-trade security verdict (bytecode X-ray, LP stress test, OFT parity, all findings).",
    mimeType: "application/json",
    payTo: cfg.receiver,
    maxTimeoutSeconds: 120,
    asset: CONTRACTS.base.usdc,
    extra: { name: "USD Coin", version: "2" },
  };
}

interface ExactPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
  };
}

export type VerifyResult = { ok: true; payer: Address; settlement: unknown } | { ok: false; reason: string };

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export async function verifyPayment(header: string, req: PaymentRequirements): Promise<VerifyResult> {
  let p: ExactPayload;
  try {
    p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "X-PAYMENT is not base64-encoded JSON." };
  }
  if (p.scheme !== "exact" || p.network !== "base") return { ok: false, reason: "Unsupported scheme/network (expected exact/base)." };
  const a = p.payload?.authorization;
  if (!a || !p.payload.signature) return { ok: false, reason: "Missing authorization or signature." };
  if (!isAddress(a.from) || !isAddress(a.to)) return { ok: false, reason: "Malformed addresses in authorization." };
  if (getAddress(a.to) !== req.payTo) return { ok: false, reason: "Authorization `to` does not match payTo." };
  if (BigInt(a.value) < BigInt(req.maxAmountRequired)) return { ok: false, reason: "Authorized value below price." };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(a.validAfter) > now || BigInt(a.validBefore) <= now) return { ok: false, reason: "Authorization outside its validity window." };

  const valid = await verifyTypedData({
    address: getAddress(a.from),
    domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: req.asset },
    types: TRANSFER_WITH_AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: p.payload.signature,
  }).catch(() => false);
  if (!valid) return { ok: false, reason: "EIP-712 signature does not recover to `from`." };

  const [used, balance] = await Promise.all([
    basePublicClient.readContract({ address: req.asset, abi: USDC_EIP3009_ABI, functionName: "authorizationState", args: [getAddress(a.from), a.nonce] }),
    basePublicClient.readContract({ address: req.asset, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(a.from)] }),
  ]);
  if (used) return { ok: false, reason: "Authorization nonce already used onchain." };
  if (balance < BigInt(a.value)) return { ok: false, reason: "Payer USDC balance below authorized value." };

  const cfg = x402Config();
  let settlement: unknown = { status: "verified", settled: false, note: "Signature, nonce and balance verified onchain; settlement deferred (no facilitator configured)." };
  if (cfg.facilitator) {
    try {
      const res = await fetch(`${cfg.facilitator.replace(/\/+$/, "")}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: p, paymentRequirements: req }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || (body as { success?: boolean }).success === false) return { ok: false, reason: `Facilitator settlement failed (${res.status}).` };
      settlement = body;
    } catch {
      return { ok: false, reason: "Facilitator unreachable." };
    }
  }
  return { ok: true, payer: getAddress(a.from), settlement };
}
