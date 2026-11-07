import { json, preflight } from "@/lib/api";
import { x402Config } from "@/lib/x402";

export const runtime = "nodejs";

const addr = { name: "address", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } };
const chain = { name: "chainId", in: "query", required: false, schema: { type: "integer", enum: [8453, 4663], default: 8453 } };

export async function GET(req: Request) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  const cfg = x402Config();
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Kestrel ($KEST) Sentinel API",
      version: "0.1.0",
      description: "Live overnight risk, liquidity, bridge-parity and tranche-escrow intelligence for Base (8453) and Robinhood Chain (4663). Every value is read live from mainnet RPCs or the Vibestarter public API — no mock data.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/scan": {
        get: {
          summary: "Unified live scan (wallet / token / pool / escrow / contract)",
          parameters: [addr, chain, { name: "llm", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: "0 = deterministic brief only" }, { name: "tokens", in: "query", schema: { type: "string" }, description: "Comma-separated extra ERC-20s to check for wallet approvals" }],
          responses: { "200": { description: "ScanResult with score, band, findings, xray, pool, flow, wallet, escrow, parity, brief" } },
        },
      },
      "/api/parity": { get: { summary: "$VIBES OFT 1:1 proof-of-reserve + cross-venue spread", responses: { "200": { description: "ParityReport" } } } },
      "/api/backer-shield": {
        get: {
          summary: "Vibestarter tranche escrows (all, or one via ?escrow=)",
          parameters: [{ name: "escrow", in: "query", schema: { type: "string" } }, chain],
          responses: { "200": { description: "Escrow reports with tranche timeline, challenge windows and findings" } },
        },
      },
      "/api/brief": {
        post: {
          summary: "Morning Desk Brief (0G Compute → Anthropic → deterministic)",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { address: { type: "string" }, chainId: { type: "integer" } }, required: ["address"] } } } },
          responses: { "200": { description: "{ brief: { text, source, model }, score, band }" } },
        },
      },
      "/api/v1/guard": {
        get: {
          summary: "Agent pre-trade security verdict (ALLOW | WARN | BLOCK)",
          description: `mode=preview is free. mode=full requires x402 payment: ${cfg.priceAtomic} atomic USDC (6 decimals) on Base via EIP-3009 X-PAYMENT header; otherwise HTTP 402 with payment requirements.`,
          parameters: [addr, chain, { name: "mode", in: "query", schema: { type: "string", enum: ["preview", "full"], default: "preview" } }, { name: "X-PAYMENT", in: "header", required: false, schema: { type: "string" }, description: "base64 x402 PaymentPayload (scheme exact, network base)" }],
          responses: { "200": { description: "Verdict" }, "402": { description: "x402 Payment Required — body contains `accepts` requirements" } },
        },
        post: { summary: "Same as GET with JSON body { address, chainId, mode }", responses: { "200": { description: "Verdict" }, "402": { description: "Payment required" } } },
      },
      "/api/mcp": { post: { summary: "Streamable HTTP MCP server (JSON-RPC 2.0): scan_contract, check_bridge_parity, simulate_exit, inspect_vibestarter_escrow", responses: { "200": { description: "JSON-RPC response" }, "202": { description: "Notification accepted" } } } },
      "/api/pager/test": {
        post: {
          summary: "Evaluate armed rules live and dispatch a test Night-Shift Pager alert",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { webhookUrl: { type: "string" }, telegramChatId: { type: "string" }, target: { type: "string" }, chainId: { type: "integer" }, rules: { type: "object" } } } } } },
          responses: { "200": { description: "{ triggers, message, deepLink, delivered }" } },
        },
      },
    },
  };
  return json(spec, { cache: "public, s-maxage=3600" });
}

export const OPTIONS = preflight;
