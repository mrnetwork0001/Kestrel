import { CONTRACTS } from "@/config/contracts";
import { json, preflight } from "@/lib/api";
import { RULE_TYPES } from "@/lib/pager/rules";
import { siteUrl } from "@/lib/site";
import { DRY_RUN_OUTCOMES } from "@/lib/vibestarter/challenge";
import { NETWORK_V1, NETWORK_V2, x402Config } from "@/lib/x402";
import { facilitatorInfo } from "@/lib/x402-facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ building blocks */

type Obj = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });
const jsonBody = (schema: Obj, description?: string) => ({ ...(description ? { description } : {}), content: { "application/json": { schema } } });
const ok = (schema: Obj, description = "OK") => jsonBody(schema, description);
const q = (name: string, schema: Obj, description: string, required = false) => ({ name, in: "query", required, schema, description });

const ADDRESS = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", examples: [CONTRACTS.base.vibesToken] };
const UINT = { type: "string", pattern: "^[0-9]+$", description: "uint256 as a decimal string (raw units / wei); never a JSON number" };
const CHAIN = { type: "integer", enum: [8453, 4663], description: "8453 = Base Mainnet, 4663 = Robinhood Chain Mainnet" };

const addressQ = q("address", ADDRESS, "Wallet, token, pool, contract or Vibestarter escrow address", true);
const chainQ = q("chainId", { ...CHAIN, default: 8453 }, "Chain (default 8453). Values other than 4663 read Base.");
const escrowQ = (required = false) => q("escrow", ADDRESS, "VibesTranchEscrow address", required);
const deskAuth = [{ deskKey: [] }];
const watchIdP = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^w_[A-Za-z0-9_-]{6,20}$" }, description: "Watch id (w_…)" };

/** Standard pager error set (desk-key routes). */
const pagerErrors = (...extra: string[]) =>
  Object.fromEntries(
    [
      ["400", "BadRequest"],
      ["401", "Unauthorized"],
      ["404", "NotFound"],
      ["429", "RateLimited"],
      ["503", "StorageUnavailable"],
      ...extra.map((e) => [e.split(":")[0], e.split(":")[1]]),
    ].map(([code, name]) => [code, resp(name)])
  );

/* ------------------------------------------------------------------ GET /api/openapi.json */

export async function GET(req: Request) {
  const origin = siteUrl(req);
  const cfg = x402Config();
  const fac = facilitatorInfo();
  const priceUsdc = (Number(cfg.priceAtomic) / 1e6).toString();

  const x402Extension = {
    versions: [2, 1],
    scheme: "exact",
    network: { v2: NETWORK_V2, v1: NETWORK_V1 },
    asset: cfg.asset,
    amountAtomic: cfg.priceAtomic,
    payTo: cfg.receiver,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    configured: Boolean(cfg.receiver),
    facilitator: fac,
  };

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Kestrel ($KEST) Sentinel API",
      version: "0.2.0",
      summary: "Autonomous overnight risk, liquidity, bridge parity and tranche-escrow sentinel for Base & Robinhood Chain.",
      description:
        "Live overnight risk, liquidity, $VIBES bridge parity and Vibestarter tranche-escrow intelligence for Base (8453) and Robinhood Chain (4663). Every value is read live from mainnet RPCs, Vibestarter's public API or Vibestarter's MCP server, with block numbers; nothing is mocked. When a read fails the response says so (502 / `unavailable` / `degraded`) instead of guessing. All uint256 values are decimal strings. Rate limits are per IP (fixed 60 s windows unless noted) and answer 429. All JSON routes send `Access-Control-Allow-Origin: *`. Machine-readable product summary: /llms.txt. MCP server: POST /api/mcp.",
      contact: { name: "Kestrel", url: `${origin}/agents` },
    },
    servers: [{ url: origin }],
    externalDocs: { description: "Agent docs (guard, x402, MCP)", url: `${origin}/agents` },
    tags: [
      { name: "Scan", description: "Briefing, X-Ray, threat score" },
      { name: "Agents", description: "Pre-trade gate (x402), MCP" },
      { name: "Bridge", description: "$VIBES LayerZero OFT parity and lanes" },
      { name: "Vibestarter", description: "Backer Shield, Challenge Co-pilot, Ecosystem board" },
      { name: "Pager", description: "Night-Shift Pager desks, watches, Sleep Mode, public log" },
      { name: "Meta", description: "Telemetry, cards, this document" },
    ],
    paths: {
      "/api/scan": {
        get: {
          tags: ["Scan"],
          operationId: "scan",
          summary: "Unified live scan (wallet / token / pool / escrow / contract)",
          description:
            "Classifies the address and reads it live: bytecode X-Ray (dispatcher selectors, EIP-1967 / ZeppelinOS / beacon / EIP-1167 / EIP-7702), owner posture, pool reserves and 8h LP / price deltas, Transfer-log whale ranking, wallet ERC-20 + Permit2 approvals (Safes and smart wallets are scanned as wallets), Vibestarter escrow state and $VIBES parity. Returns a 0-100 Overnight Threat Score (NOMINAL 0-29, ELEVATED 30-64, CRITICAL 65-100), findings and the deterministic Morning Desk Brief (the LLM brief is POST /api/brief). 40/min. Complete scans are cached 30 s; a scan where a live read failed is returned with `X-Kestrel-Scan-Status: degraded` + Retry-After and never cached; an address that could not be classified at all answers 503.",
          parameters: [
            addressQ,
            { ...chainQ, description: "8453 (default) or 4663; anything else is 400" },
            q("mode", { type: "string", enum: ["auto", "wallet"], default: "auto" }, "wallet = force the wallet / approval scan for any address (Panic Bunker subject). Smart-contract wallets are auto-classified as wallets in auto mode too."),
            q("tokens", { type: "string" }, "Comma-separated extra ERC-20 addresses (max 8) to include in the wallet approval scan"),
            q("llm", { type: "string" }, "Accepted for backward compatibility and ignored (no LLM call on this route)"),
          ],
          responses: {
            "200": {
              description: "ScanResult",
              headers: { "X-Kestrel-Scan-Status": { description: "complete | degraded (a live read failed; retry after Retry-After seconds)", schema: { type: "string", enum: ["complete", "degraded"] } } },
              content: { "application/json": { schema: ref("ScanResult") } },
            },
            "400": resp("BadRequest"),
            "429": resp("RateLimited"),
            "503": { description: "Live scan unavailable: nothing was classified (status degraded, retryAfterSec)", content: { "application/json": { schema: ref("Error") } } },
          },
        },
      },
      "/api/brief": {
        post: {
          tags: ["Scan"],
          operationId: "brief",
          summary: "Morning Desk Brief (0G Compute → Anthropic → deterministic)",
          description:
            "The only route that may call an LLM. Runs a live scan and returns the plain-English brief. Provider order: 0G Compute Router, then Anthropic, then a deterministic brief built only from live findings. External strings are sanitized and fenced as untrusted data. 10/min and 40/hour per IP, a shared daily LLM budget (BRIEF_LLM_DAILY_CAP), cached 120 s per target except for incomplete scans.",
          requestBody: { required: true, ...jsonBody({ type: "object", properties: { address: ADDRESS, chainId: { ...CHAIN, default: 8453 } }, required: ["address"] }) },
          responses: {
            "200": ok({
              type: "object",
              required: ["brief", "llm", "status", "score", "band", "block", "target"],
              properties: {
                brief: ref("Brief"),
                llm: { type: "object", properties: { configured: { type: "boolean" }, dailyCap: { type: "integer" } } },
                status: { type: "string", enum: ["complete", "degraded"] },
                score: { type: "integer" },
                band: ref("Band"),
                block: ref("BlockRef"),
                target: ref("Target"),
              },
            }),
            "400": resp("BadRequest"),
            "429": resp("RateLimited"),
            "503": { description: "Brief unavailable (live scan failed; status degraded, retryAfterSec)", content: { "application/json": { schema: ref("Error") } } },
          },
        },
      },
      "/api/v1/guard": {
        get: {
          tags: ["Agents"],
          operationId: "guard",
          summary: "Agent pre-trade security gate (ALLOW | WARN | BLOCK)",
          description: [
            "mode=preview (default) is free (60/min, cached 30 s): verdict, score, band, top 3 reasons, simulated 1% exit slippage, pool depth.",
            `mode=full is an x402 resource: ${priceUsdc} USDC (${cfg.priceAtomic} atomic, 6 decimals) on Base, scheme "exact" (EIP-3009 transferWithAuthorization). Without a payment header it answers 402: the v2 PaymentRequired is base64 JSON in the \`PAYMENT-REQUIRED\` header and the v1 PaymentRequired is the JSON body.`,
            "Retry with `PAYMENT-SIGNATURE` (x402 v2, network eip155:8453) or `X-PAYMENT` (legacy v1, network base). Pipeline: replay lock on (payer, nonce) → onchain authorizationState check → facilitator /verify → live scan → facilitator /settle (onchain) → 200 with the full report, a `payment` object and `PAYMENT-RESPONSE` (v2) / `X-PAYMENT-RESPONSE` (v1). The verdict is only returned after settlement; each authorization yields at most one 200; if the scan fails nothing is settled and the same header can be retried.",
            "Fails closed: an address with no contract code is BLOCK for intent=trade, any RPC uncertainty gives at least WARN with status 'degraded', retryAfterSec and `X-Kestrel-Guard-Status: degraded` (never cached), and a free-tier scan that could not classify the address at all answers 503 with Retry-After.",
          ].join("\n\n"),
          parameters: [
            q("address", ADDRESS, "Token, pool, wallet or escrow address (required except for a bare mode=full probe, which answers 402)"),
            { ...chainQ, description: "8453 (default) or 4663; anything else is 400" },
            q("mode", { type: "string", enum: ["preview", "full"], default: "preview" }, "preview = free, full = x402 paid"),
            q("intent", { type: "string", enum: ["trade", "counterparty"], default: "trade" }, "trade: a token / pool you will swap or approve (no code = BLOCK). counterparty: a wallet you will send to."),
            { name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string" }, description: "x402 v2: base64 JSON PaymentPayload (scheme exact, network eip155:8453)" },
            { name: "X-PAYMENT", in: "header", required: false, schema: { type: "string" }, description: "x402 v1 (legacy): base64 JSON PaymentPayload (scheme exact, network base)" },
          ],
          responses: {
            "200": {
              description: "Verdict. Paid (mode=full) responses add the full report and `payment`.",
              headers: {
                "X-Kestrel-Guard-Status": { description: "complete | degraded", schema: { type: "string", enum: ["complete", "degraded"] } },
                "PAYMENT-RESPONSE": { description: "x402 v2 settlement receipt (base64 JSON: success, transaction, network, payer)", schema: { type: "string" } },
                "X-PAYMENT-RESPONSE": { description: "x402 v1 settlement receipt (base64 JSON)", schema: { type: "string" } },
              },
              content: { "application/json": { schema: { oneOf: [ref("GuardPreview"), ref("GuardFull")] } } },
            },
            "202": {
              description: "Settlement not final yet (pending broadcast, facilitator timeout or unconfirmed). Retry with the SAME payment header after Retry-After; it is accepted for recovery even after validBefore. Never sign a new payment for this. Body: { status: \"settlement_pending\", retryWithSameHeader: true, retryAfterSec, transaction }.",
              headers: {
                "PAYMENT-RESPONSE": { description: "x402 v2 receipt with success:false, errorReason settlement_pending", schema: { type: "string" } },
                "Retry-After": { description: "Seconds before retrying with the same header", schema: { type: "integer" } },
              },
              content: { "application/json": { schema: { type: "object" } } },
            },
            "400": resp("BadRequest"),
            "402": {
              description: "Payment Required (mode=full without a valid, unused payment). `error` names the reason, e.g. payment_already_used, payment_in_flight, authorization_expired_unsettled, authorization_window_too_long. Recovery of a paid verdict requires the exact original header and request (address, chainId, intent).",
              headers: {
                "PAYMENT-REQUIRED": { description: "x402 v2 PaymentRequired, base64 JSON (x402Version 2, resource, accepts[], extensions incl. Bazaar discovery)", schema: { type: "string" } },
                "PAYMENT-RESPONSE": { description: "Present after a failed settlement (v2)", schema: { type: "string" } },
                "X-PAYMENT-RESPONSE": { description: "Present after a failed settlement (v1)", schema: { type: "string" } },
              },
              content: { "application/json": { schema: ref("PaymentRequiredV1") } },
            },
            "429": resp("RateLimited"),
            "501": { description: "Paid tier not configured on this deployment (X402_RECEIVER_ADDRESS unset or facilitator misconfigured). Use mode=preview.", content: { "application/json": { schema: ref("Error") } } },
            "502": resp("UpstreamFailed"),
            "503": {
              description: "Free tier: live scan could not classify the address (verdict body with status degraded + scanError, Retry-After). Paid tier: replay ledger (Upstash) unavailable or missing in production; payment was not used.",
              content: { "application/json": { schema: { oneOf: [ref("GuardPreview"), ref("Error")] } } },
            },
          },
          "x-x402": x402Extension,
        },
        post: {
          tags: ["Agents"],
          operationId: "guardPost",
          summary: "Same as GET with a JSON body",
          parameters: [
            { name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string" }, description: "x402 v2 payment" },
            { name: "X-PAYMENT", in: "header", required: false, schema: { type: "string" }, description: "x402 v1 payment" },
          ],
          requestBody: {
            required: true,
            ...jsonBody({
              type: "object",
              properties: {
                address: ADDRESS,
                chainId: { ...CHAIN, default: 8453 },
                mode: { type: "string", enum: ["preview", "full"], default: "preview" },
                intent: { type: "string", enum: ["trade", "counterparty"], default: "trade" },
              },
            }),
          },
          responses: {
            "200": ok({ oneOf: [ref("GuardPreview"), ref("GuardFull")] }, "Verdict (see GET)"),
            "400": resp("BadRequest"),
            "402": { description: "Payment Required (see GET)", content: { "application/json": { schema: ref("PaymentRequiredV1") } } },
            "429": resp("RateLimited"),
            "501": { description: "Paid tier not configured", content: { "application/json": { schema: ref("Error") } } },
            "502": resp("UpstreamFailed"),
            "503": { description: "Replay ledger unavailable", content: { "application/json": { schema: ref("Error") } } },
          },
          "x-x402": x402Extension,
        },
      },
      "/api/x402/revenue": {
        get: {
          tags: ["Agents"],
          operationId: "x402Revenue",
          summary: "Onchain proof of x402 revenue",
          description:
            "Base USDC Transfer logs into X402_RECEIVER_ADDRESS, scanned from X402_LEDGER_FROM_BLOCK (or ~24h back) with an incremental cursor; newest rows are labelled EIP-3009 settlements from their receipts, plus the server ledger count for cross-checking. `configured: false` (HTTP 200) when the deployment has no receiver. Cached 60 s, 30/min.",
          responses: { "200": ok(ref("RevenueReport")), "429": resp("RateLimited"), "502": resp("UpstreamFailed") },
        },
      },
      "/api/mcp": {
        post: {
          tags: ["Agents"],
          operationId: "mcp",
          summary: "Streamable HTTP MCP server (JSON-RPC 2.0, stateless, JSON responses)",
          description:
            "Methods: initialize, ping, tools/list, tools/call (notifications answer 202). Tools: scan_contract, check_bridge_parity, simulate_exit, inspect_vibestarter_escrow, challenge_copilot, challenge_dry_run, ecosystem_health, vibestarter_pulse (read-only) and create_watch, list_watches, delete_watch (Night-Shift Pager; deskKey passed as a tool argument). Batches up to 20 messages; each message costs one rate-limit unit (60/min). Browser requests with an Origin other than this site are rejected (403) per the MCP spec; clients without Origin (Claude Code, SDKs) are allowed. An unsupported MCP-Protocol-Version header answers 400. Tool input problems come back as results with isError: true.",
          parameters: [{ name: "MCP-Protocol-Version", in: "header", required: false, schema: { type: "string", enum: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] } }],
          requestBody: {
            required: true,
            ...jsonBody({ oneOf: [ref("JsonRpcRequest"), { type: "array", items: ref("JsonRpcRequest"), minItems: 1, maxItems: 20 }] }),
          },
          responses: {
            "200": ok({ oneOf: [ref("JsonRpcResponse"), { type: "array", items: ref("JsonRpcResponse") }] }, "JSON-RPC response (or array for a batch)"),
            "202": { description: "Only notifications / client responses were sent" },
            "400": { description: "Parse error (-32700), empty or oversized batch (-32600), or unsupported MCP-Protocol-Version", content: { "application/json": { schema: ref("JsonRpcResponse") } } },
            "403": { description: "Origin not allowed", content: { "application/json": { schema: ref("JsonRpcResponse") } } },
            "429": { description: "Rate limited (-32000)", content: { "application/json": { schema: ref("JsonRpcResponse") } } },
          },
        },
        get: { tags: ["Agents"], operationId: "mcpInfo", summary: "Describes the endpoint (no SSE stream offered)", responses: { "405": ok({ type: "object" }, "Method Not Allowed, with a JSON description and tool names") } },
      },
      "/api/parity": {
        get: {
          tags: ["Bridge"],
          operationId: "parity",
          summary: "$VIBES OFT 1:1 proof-of-reserve, bridge lane X-Ray and cross-venue spread",
          description:
            "Reads both chains: Base adapter balanceOf(VIBES) vs Robinhood totalSupply − reserve adapter balanceOf → verdict EXACT / IN_FLIGHT / OVER_BACKED / UNBACKED (UNBACKED only after a confirming second read). Bridge lanes: live LayerZero quoteSend fee with executor/DVN/treasury breakdown, inbound credit budget (creditBudget(srcEid) on the destination adapter: limit, window, in-flight, headroom), pause flags, peers, DVN set, config match, nonces / undelivered packets, adapter governance. Spread: Base Aerodrome vs Robinhood Uniswap v3 VIBES/WETH; netEdgeBps is after pool fees, the LayerZero fee and gas (null when the fee is unreadable), plus an exact round-trip model. Cached 15 s.",
          responses: { "200": ok(ref("ParityReport")), "502": resp("UpstreamFailed") },
        },
      },
      "/api/backer-shield": {
        get: {
          tags: ["Vibestarter"],
          operationId: "backerShield",
          summary: "Vibestarter tranche escrows: all, one in depth, or the Pulse",
          description:
            "No params: every VibesTranchEscrow on Base and Robinhood Chain (factory getAllEscrows + public API + Vibestarter MCP) with tranche timeline (10% kickstart + six 15% monthly), 72h challenge windows, Proof-of-Lock, Refund Radar, founder app HTTP health, founder GitHub velocity, Origin Capsule and findings. ?escrow=…: one escrow. ?view=pulse: Vibestarter Pulse (Vibestarter MCP get_platform_stats + list_raises, REST fallback) with the liquidity-locked figure reconciled against VibesLPLockerV2 onchain. 40/min, cached 30-60 s.",
          parameters: [escrowQ(), chainQ, q("view", { type: "string", enum: ["pulse"] }, "pulse = Vibestarter Pulse")],
          responses: {
            "200": ok({
              oneOf: [
                { type: "object", title: "All escrows", required: ["escrows", "fetchedAt"], properties: { escrows: { type: "array", items: ref("EscrowReport") }, universe: { type: ["object", "null"] }, fetchedAt: { type: "string", format: "date-time" } } },
                { type: "object", title: "One escrow", required: ["escrow", "findings"], properties: { escrow: ref("EscrowReport"), findings: { type: "array", items: ref("Finding") } } },
                ref("VibestarterPulse"),
              ],
            }),
            "400": resp("BadRequest"),
            "429": resp("RateLimited"),
            "502": resp("UpstreamFailed"),
          },
        },
      },
      "/api/challenge": {
        get: {
          tags: ["Vibestarter"],
          operationId: "challengeCopilot",
          summary: "Backer Challenge Co-pilot (read side)",
          description:
            "No params: co-pilot summary for every known escrow on both chains. With ?escrow: escrow version, phase, next-tranche countdowns (escrow's own getCurrentTime), exact bond and 20% slash at risk, trust surface, vote tally when a challenge is pending, refund-if-upheld snapshot computed by upholdChallenge() inside eth_simulateV1, and a readiness checklist in contract revert order. With &wallet: that wallet's balance, allowance, contribution, credential / nonce, cooldown, vote and per-action verdicts. 30/min, cached 15 s (wallet reads uncached).",
          parameters: [escrowQ(), chainQ, q("wallet", ADDRESS, "Optional backer wallet")],
          responses: {
            "200": ok({ oneOf: [ref("CopilotReport"), { type: "object", title: "All escrows", required: ["escrows", "fetchedAt"], properties: { escrows: { type: "array", items: { oneOf: [ref("CopilotReport"), { type: "object", properties: { chainId: CHAIN, escrow: ADDRESS, title: { type: ["string", "null"] }, error: { type: "string" } } }] } }, fetchedAt: { type: "string" } } }] }),
            "400": resp("BadRequest"),
            "429": resp("RateLimited"),
            "502": resp("UpstreamFailed"),
          },
        },
        post: {
          tags: ["Vibestarter"],
          operationId: "challengeDryRun",
          summary: "Challenge Dry-Run: real escrow bytecode in eth_simulateV1",
          description: "Synthetic actors, at most five storage-slot overrides (each listed and verified against its getter). Scenarios raise / reject / uphold / expire. Nothing is broadcast. 10/min, cached 30 s.",
          requestBody: {
            required: true,
            ...jsonBody({
              type: "object",
              required: ["escrow"],
              properties: { action: { type: "string", enum: ["dry-run"], default: "dry-run" }, escrow: ADDRESS, chainId: { ...CHAIN, default: 8453 }, outcomes: { type: "array", items: { type: "string", enum: DRY_RUN_OUTCOMES } } },
            }),
          },
          responses: { "200": ok(ref("DryRunResult")), "400": resp("BadRequest"), "429": resp("RateLimited"), "502": resp("UpstreamFailed") },
        },
      },
      "/api/ecosystem": {
        get: {
          tags: ["Vibestarter"],
          operationId: "ecosystem",
          summary: "Vibestarter Ecosystem Health Board",
          description:
            "Every Vibestarter launch with token X-Ray score, Proof-of-Lock, pool depth, escrow state + next countdown, Refund Radar, founder app HTTP health, founder GitHub velocity and Origin Capsule. 120 s stale-while-revalidate cache (`cache.ageSec`, `cache.stale`). 30/min.",
          parameters: [q("chainId", CHAIN, "Only launches on this chain"), escrowQ()],
          responses: {
            "200": ok({ oneOf: [ref("EcosystemBoard"), { type: "object", title: "One row", required: ["row"], properties: { row: ref("EcosystemRow") } }] }),
            "400": resp("BadRequest"),
            "404": resp("NotFound"),
            "429": resp("RateLimited"),
            "502": resp("UpstreamFailed"),
          },
        },
      },

      /* ---------------- Night-Shift Pager ---------------- */
      "/api/pager/desk": {
        post: {
          tags: ["Pager"],
          operationId: "createDesk",
          summary: "Open an anonymous desk (returns the desk key once)",
          description: "No account. The server stores only sha256(deskKey). 5 per hour and PAGER_MAX_DESKS_PER_IP_DAY per day per network.",
          requestBody: { required: false, ...jsonBody({ type: "object", properties: { label: { type: "string", maxLength: 60 } }, additionalProperties: false }) },
          responses: {
            "201": ok({ type: "object", required: ["deskKey", "desk", "notice"], properties: { deskKey: { type: "string", pattern: "^kst_[A-Za-z0-9_-]{20,64}$" }, desk: ref("DeskPublic"), notice: { type: "string" } } }, "Created"),
            "400": resp("BadRequest"),
            "413": resp("TooLarge"),
            "429": resp("RateLimited"),
            "503": resp("StorageUnavailable"),
          },
        },
        get: {
          tags: ["Pager"],
          operationId: "getDesk",
          summary: "Desk with watches, recent alerts, digests, sleep session and last tick",
          security: deskAuth,
          responses: {
            "200": ok({
              type: "object",
              required: ["desk", "watches", "recentAlerts", "digests", "sleep", "cadenceSec", "lastTick"],
              properties: {
                desk: ref("DeskPublic"),
                watches: { type: "array", items: ref("WatchView") },
                recentAlerts: { type: "array", items: { type: "object" } },
                digests: { type: "array", items: ref("DigestPayload"), maxItems: 3 },
                sleep: { oneOf: [ref("SleepPublic"), { type: "null" }] },
                cadenceSec: { type: "integer" },
                lastTick: { oneOf: [ref("TickSummary"), { type: "null" }] },
              },
            }),
            ...pagerErrors(),
          },
        },
        patch: {
          tags: ["Pager"],
          operationId: "patchDesk",
          summary: "Label, delivery channels and sleep policy",
          description: "webhookUrl must be https:443 and public (SSRF-guarded: private/special ranges, rebinding and redirects blocked). Discord and Slack URLs get native payloads; any other URL gets HMAC-signed JSON and a `whsec_` secret (returned only when newly issued or rotated). telegramChatId here is stored as an UNVERIFIED pending link and receives no pages until that chat presses Start via /api/pager/telegram/link.",
          security: deskAuth,
          requestBody: {
            required: true,
            ...jsonBody({
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: ["string", "null"], maxLength: 60 },
                webhookUrl: { type: ["string", "null"], format: "uri" },
                telegramChatId: { type: ["string", "integer", "null"] },
                sleepPolicy: { type: "string", enum: ["critical-only", "page-all"] },
                rotateWebhookSecret: { type: "boolean", const: true },
              },
            }),
          },
          responses: { "200": ok({ type: "object", required: ["desk"], properties: { desk: ref("DeskPublic"), webhookSecret: { type: "string" } } }), ...pagerErrors("413:TooLarge") },
        },
        delete: { tags: ["Pager"], operationId: "deleteDesk", summary: "Delete the desk and everything on it", security: deskAuth, responses: { "204": { description: "Deleted" }, ...pagerErrors() } },
      },
      "/api/pager/watches": {
        get: {
          tags: ["Pager"],
          operationId: "listWatches",
          summary: "The desk's watches with display-ready status",
          security: deskAuth,
          responses: { "200": ok({ type: "object", required: ["watches", "limits"], properties: { watches: { type: "array", items: ref("WatchView") }, limits: { type: "object", properties: { maxWatches: { type: "integer" } } } } }), ...pagerErrors() },
        },
        post: {
          tags: ["Pager"],
          operationId: "createWatch",
          summary: "Arm a watch (baselines seeded from live chain state, 3-20 s)",
          security: deskAuth,
          requestBody: {
            required: true,
            ...jsonBody({
              type: "object",
              required: ["address"],
              additionalProperties: false,
              properties: {
                address: ADDRESS,
                chainId: { ...CHAIN, default: 8453 },
                label: { type: "string", maxLength: 80 },
                rules: { type: "array", maxItems: 32, items: { oneOf: [{ type: "string", enum: RULE_TYPES }, ref("RuleConfigInput")] }, description: "Omit for the defaults of the target kind" },
                extraTokens: { type: "array", maxItems: 10, items: ADDRESS, description: "Extra Base tokens for wallet approval-log coverage" },
              },
            }),
          },
          responses: {
            "201": ok(
              {
                type: "object",
                required: ["watch", "scan", "observations", "baselineErrors"],
                properties: {
                  watch: ref("WatchView"),
                  scan: { type: "object", properties: { score: { type: "integer" }, band: ref("Band"), kind: ref("TargetKind"), label: { type: "string" }, block: UINT } },
                  observations: { type: "array", items: ref("RuleObservation") },
                  baselineErrors: { type: "array", items: { type: "string" } },
                },
              },
              "Armed"
            ),
            ...pagerErrors("409:Conflict", "413:TooLarge", "502:UpstreamFailed"),
          },
        },
      },
      "/api/pager/watches/{id}": {
        parameters: [watchIdP],
        get: { tags: ["Pager"], operationId: "getWatch", summary: "One watch", security: deskAuth, responses: { "200": ok({ type: "object", required: ["watch"], properties: { watch: ref("WatchView") } }), ...pagerErrors() } },
        patch: {
          tags: ["Pager"],
          operationId: "patchWatch",
          summary: "Enable/disable, relabel, or change rules (merged over the current config)",
          security: deskAuth,
          requestBody: { required: true, ...jsonBody({ type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" }, label: { type: "string", maxLength: 80 }, rules: { type: "array", items: ref("RuleConfigInput") } } }) },
          responses: { "200": ok({ type: "object", required: ["watch"], properties: { watch: ref("WatchView") } }), ...pagerErrors("413:TooLarge") },
        },
        delete: { tags: ["Pager"], operationId: "deleteWatch", summary: "Delete a watch", security: deskAuth, responses: { "204": { description: "Deleted" }, ...pagerErrors() } },
      },
      "/api/pager/watches/{id}/test": {
        parameters: [watchIdP],
        post: {
          tags: ["Pager"],
          operationId: "testWatch",
          summary: "Live dry run of one watch's rules (optionally dispatched, labelled TEST)",
          description: "Runs the same batched probe pass as the tick against live state (log window = blocks since the last check, capped like the tick). Never mutates the watch state. 6/min per desk.",
          security: deskAuth,
          requestBody: { required: false, ...jsonBody({ type: "object", additionalProperties: false, properties: { dispatch: { type: "boolean", default: false } } }) },
          responses: {
            "200": ok({
              type: "object",
              required: ["evaluatedAt", "chainId", "block", "range", "observations", "alerts", "message", "delivered", "errors"],
              properties: {
                evaluatedAt: { type: "integer" },
                chainId: CHAIN,
                block: UINT,
                range: { type: "object", properties: { from: UINT, to: UINT, gapBlocks: UINT } },
                observations: { type: "array", items: ref("RuleObservation") },
                alerts: { type: "array", items: { type: "object" } },
                message: { type: "object", properties: { text: { type: "string" }, html: { type: "string" } } },
                delivered: { type: "array", items: ref("Delivery") },
                errors: { type: "array", items: { type: "string" } },
              },
            }),
            ...pagerErrors("413:TooLarge", "502:UpstreamFailed"),
          },
        },
      },
      "/api/pager/sleep": {
        get: {
          tags: ["Pager"],
          operationId: "sleepStatus",
          summary: "Sleep Mode status, wake countdown and last digest",
          security: deskAuth,
          responses: {
            "200": ok({ type: "object", required: ["sleep", "now", "wakeInSec", "lastDigest"], properties: { sleep: { oneOf: [ref("SleepPublic"), { type: "null" }] }, now: { type: "integer" }, wakeInSec: { type: ["integer", "null"] }, lastDigest: { oneOf: [ref("DigestPayload"), { type: "null" }] } } }),
            ...pagerErrors(),
          },
        },
        post: {
          tags: ["Pager"],
          operationId: "startSleep",
          summary: "Start Sleep Mode (bedtime snapshot from the latest tick, no RPC)",
          description: "Wake time is clamped to now + 2 min … now + 16 h. critical-only pages only CRITICAL alerts overnight and holds the rest for the digest; page-all pages everything. 10/hour per desk.",
          security: deskAuth,
          requestBody: {
            required: true,
            ...jsonBody({
              type: "object",
              additionalProperties: false,
              properties: {
                wakeAt: { type: ["string", "integer"], description: "ISO time or epoch ms" },
                wakeTime: { type: "string", pattern: "^\\d{1,2}:\\d{2}$", description: "Local HH:MM (with tz / tzOffsetMin)" },
                tz: { type: "string", description: "IANA zone or offset like +02:00" },
                tzOffsetMin: { type: "number", description: "Minutes EAST of UTC" },
                policy: { type: "string", enum: ["critical-only", "page-all"] },
              },
            }),
          },
          responses: {
            "200": ok({ type: "object", required: ["sleep", "clamped", "snapshotWatches", "pendingFirstCheck"], properties: { sleep: ref("SleepPublic"), clamped: { type: "boolean" }, snapshotWatches: { type: "integer" }, pendingFirstCheck: { type: "integer", description: "Watches with no completed check yet" } } }),
            ...pagerErrors("413:TooLarge"),
          },
        },
        delete: {
          tags: ["Pager"],
          operationId: "endSleep",
          summary: "Wake up (optionally build and deliver the While-You-Slept digest now)",
          security: deskAuth,
          parameters: [q("digest", { type: "string", enum: ["1"] }, "1 = build and deliver the digest")],
          responses: {
            "200": ok({ type: "object", required: ["digest", "text", "delivered", "queued"], properties: { digest: { oneOf: [ref("DigestPayload"), { type: "null" }] }, text: { type: ["string", "null"] }, delivered: { type: "array", items: ref("Delivery") }, queued: { type: "boolean" }, note: { type: "string" } } }),
            ...pagerErrors(),
          },
        },
      },
      "/api/pager/telegram/link": {
        post: {
          tags: ["Pager"],
          operationId: "telegramLinkStart",
          summary: "Single-use Telegram deep link (https://t.me/<bot>?start=<token>, 15 min)",
          security: deskAuth,
          responses: { "200": ok({ type: "object", required: ["url", "expiresAt", "mode"], properties: { url: { type: "string", format: "uri" }, expiresAt: { type: "integer" }, mode: { type: "string", enum: ["webhook", "polling"] }, bot: { type: ["string", "null"] } } }), ...pagerErrors() },
        },
        get: {
          tags: ["Pager"],
          operationId: "telegramLinkStatus",
          summary: "Link status for the UI poller (polling mode drains getUpdates first)",
          security: deskAuth,
          responses: {
            "200": ok({
              type: "object",
              required: ["status", "mode", "configured"],
              properties: {
                status: { type: "string", enum: ["linked", "pending", "none", "expired"] },
                expiresAt: { type: "integer" },
                mode: { type: "string" },
                configured: { type: "boolean" },
                telegram: { type: "object", properties: { username: { type: ["string", "null"] }, chatType: { type: "string" }, verified: { type: "boolean" }, disabledReason: { type: ["string", "null"] }, linkedAt: { type: "integer" } } },
                pollError: { type: "string" },
              },
            }),
            ...pagerErrors(),
          },
        },
        delete: { tags: ["Pager"], operationId: "telegramUnlink", summary: "Unlink the desk's Telegram chat", security: deskAuth, responses: { "204": { description: "Unlinked" }, ...pagerErrors() } },
      },
      "/api/pager/telegram/webhook": {
        post: {
          tags: ["Pager"],
          operationId: "telegramWebhook",
          summary: "Telegram Bot API updates (webhook mode only)",
          description: "Enabled only when TELEGRAM_WEBHOOK_SECRET is set; every request must carry the matching X-Telegram-Bot-Api-Secret-Token. Answers 200 after the secret check so Telegram never re-delivers.",
          parameters: [{ name: "X-Telegram-Bot-Api-Secret-Token", in: "header", required: true, schema: { type: "string" } }],
          requestBody: { required: true, ...jsonBody({ type: "object", description: "Telegram Update" }) },
          responses: { "200": ok({ type: "object" }), "403": resp("Forbidden"), "404": { description: "Webhook mode not configured", content: { "application/json": { schema: ref("Error") } } } },
        },
      },
      "/api/pager/status": {
        get: {
          tags: ["Pager"],
          operationId: "pagerStatus",
          summary: "Public Night-Shift Log (proof-of-watch)",
          description: "No auth. Last check per chain, scheduler kind, storage mode, Telegram config and the newest hash-chained tick summaries (sha256(prevHash + JSON(summary))) verified server-side. A tick older than 3× the cadence triggers one opportunistic background tick. 60/min.",
          parameters: [q("log", { type: "integer", minimum: 0, maximum: 50, default: 10 }, "How many tick summaries to return")],
          responses: {
            "200": ok({
              type: "object",
              required: ["healthy", "cadenceSec", "scheduler", "storage", "telegram", "checks", "lastTick", "window", "chain", "log"],
              properties: {
                healthy: { type: "boolean" },
                cadenceSec: { type: "integer" },
                scheduler: { type: "object", properties: { kind: { type: "string" }, inProcess: { type: ["object", "null"] }, opportunisticTriggered: { type: "boolean" } } },
                storage: { type: "string", enum: ["upstash", "memory"] },
                telegram: { type: "object", properties: { configured: { type: "boolean" }, mode: { type: "string" } } },
                checks: { type: "integer" },
                lastTick: { type: ["object", "null"], description: "tickId, at, ageSec, reason, durationMs, chains{8453,4663}{block,ok,error?}, watches, evaluated, alerts, deliveries, hash, prevHash" },
                window: { type: ["object", "null"], description: "Aggregate over the stored log: ticks, fromAt, toAt, alerts, deliveries, digests, blocks per chain" },
                chain: { type: "object", properties: { valid: { type: "boolean" }, checked: { type: "integer" }, brokenAt: { type: ["integer", "null"] }, algorithm: { type: "string" } } },
                log: { type: "array", items: ref("TickSummary") },
                systemDesk: { type: "object", description: "Public $VIBES desk watches (labels and status only), when PAGER_SYSTEM_DESK_ID is set" },
              },
            }),
            "429": resp("RateLimited"),
            "503": resp("StorageUnavailable"),
          },
        },
      },
      "/api/pager/tick": {
        get: {
          tags: ["Pager"],
          operationId: "pagerTick",
          summary: "One sentinel pass (scheduler only)",
          description:
            "probe both chains → evaluate every watch → commit → deliver outbox → due digests → append to the public log. Auth: `Authorization: Bearer $CRON_SECRET` or a QStash `Upstash-Signature` (current/next signing keys); with no secret configured only localhost under `next dev`. Duplicates are absorbed by the tick lock (`skipped: \"locked\"`, 200) and the execution id. async=1 answers 202 immediately; dry=1 evaluates without persisting, delivering or locking.",
          security: [{ cronSecret: [] }, { qstash: [] }],
          parameters: [q("async", { type: "string", enum: ["1"] }, "Answer 202 and run in the background"), q("dry", { type: "string", enum: ["1"] }, "Evaluate only")],
          responses: {
            "200": ok({ type: "object", description: "TickSummary plus preview / telegram fields, or { skipped: \"duplicate\" | \"locked\" | \"no-storage\" | \"no-watches\" }" }),
            "202": ok({ type: "object", properties: { accepted: { type: "boolean", const: true } } }, "Accepted (async)"),
            "401": resp("Unauthorized"),
            "500": { description: "Tick failed", content: { "application/json": { schema: ref("Error") } } },
          },
        },
        post: { tags: ["Pager"], operationId: "pagerTickPost", summary: "Same as GET (QStash / Vercel Schedules use POST)", security: [{ cronSecret: [] }, { qstash: [] }], responses: { "200": ok({ type: "object" }), "202": ok({ type: "object" }, "Accepted"), "401": resp("Unauthorized"), "500": { description: "Tick failed" } } },
      },
      "/api/pager/test": {
        post: {
          tags: ["Pager"],
          operationId: "pagerQuickTest",
          summary: "Quick test page without a desk (legacy): evaluate 4 rules live and dispatch",
          description: "Rules: Aerodrome VIBES LP drop, Base↔RH spread, $VIBES parity drift, open 72h challenge window. Sends to an SSRF-guarded webhook and/or, with the desk key (Authorization: Bearer kst_…), to that desk's own VERIFIED Telegram chat; `dryRun: true` when no destination. 6/min.",
          requestBody: {
            required: true,
            ...jsonBody({
              type: "object",
              properties: {
                webhookUrl: { type: "string", format: "uri" },
                telegramChatId: { type: "string" },
                target: ADDRESS,
                chainId: { ...CHAIN, default: 8453 },
                rules: { type: "object", properties: { lpDropPct: { type: "number", minimum: 1, maximum: 90, default: 15 }, maxSpreadBps: { type: "number", minimum: 10, maximum: 5000, default: 300 }, watchChallengeWindows: { type: "boolean", default: true }, parityDrift: { type: "boolean", default: true } } },
              },
            }),
          },
          responses: {
            "200": ok({
              type: "object",
              required: ["triggers", "message", "deepLink", "delivered"],
              properties: {
                triggers: { type: "array", items: { type: "object", properties: { rule: { type: "string" }, fired: { type: "boolean" }, observed: { type: "string" } } } },
                message: { type: "string" },
                deepLink: { type: "string", format: "uri" },
                delivered: { type: "array", items: ref("Delivery") },
                dryRun: { type: "boolean" },
              },
            }),
            "400": resp("BadRequest"),
            "429": resp("RateLimited"),
            "502": resp("UpstreamFailed"),
          },
        },
      },

      /* ---------------- meta ---------------- */
      "/api/telemetry": {
        get: {
          tags: ["Meta"],
          operationId: "telemetry",
          summary: "Ribbon feed: live block heights + $VIBES OFT 1:1 status",
          description: "CDN-cached 15 s, 120/min.",
          responses: {
            "200": ok({ type: "object", required: ["baseBlock", "rhBlock", "parity", "deltaRaw", "fetchedAt"], properties: { baseBlock: UINT, rhBlock: UINT, parity: { type: "string", enum: ["VERIFIED", "IN_FLIGHT", "OVER_BACKED", "BACKED", "DRIFT", "UNKNOWN"], description: "VERIFIED = Δ 0; IN_FLIGHT / OVER_BACKED / BACKED = locked > circulating (holders covered); DRIFT = circulating > locked, confirmed by a second read" }, deltaRaw: UINT, fetchedAt: { type: "string", format: "date-time" } } }),
            "429": resp("RateLimited"),
            "502": resp("UpstreamFailed"),
          },
        },
      },
      "/api/card": {
        get: {
          tags: ["Meta"],
          operationId: "threatCard",
          summary: "Shareable Overnight Threat Card (1200×630 PNG) from a live scan",
          parameters: [q("target", ADDRESS, "Address to scan", true), q("chain", { type: "string", enum: ["8453", "4663"], default: "8453" }, "Chain")],
          responses: {
            "200": { description: "PNG image (cached 5 min at the CDN)", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
            "400": resp("BadRequest"),
            "503": { description: "Honest 'scan unavailable' card (not cached) when the live scan did not finish in 45 s", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
          },
        },
      },
      "/api/openapi.json": { get: { tags: ["Meta"], operationId: "openapi", summary: "This document", responses: { "200": ok({ type: "object" }) } } },
    },
    components: {
      securitySchemes: {
        deskKey: { type: "http", scheme: "bearer", bearerFormat: "kst_…", description: "Night-Shift Pager desk key from POST /api/pager/desk (shown once; server stores only its hash). Controls alert settings only; never funds." },
        cronSecret: { type: "http", scheme: "bearer", description: "CRON_SECRET (scheduler)" },
        qstash: { type: "apiKey", in: "header", name: "Upstash-Signature", description: "QStash JWT signed with QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY" },
      },
      responses: {
        BadRequest: { description: "Invalid input (bad address, unsupported chainId, malformed or null JSON body, unknown field)", content: { "application/json": { schema: ref("Error") } } },
        Unauthorized: { description: "Missing or malformed credential", content: { "application/json": { schema: ref("Error") } } },
        Forbidden: { description: "Forbidden", content: { "application/json": { schema: ref("Error") } } },
        NotFound: { description: "Not found (unknown desk key, watch not on this desk, unknown escrow)", content: { "application/json": { schema: ref("Error") } } },
        Conflict: { description: "Already exists (this desk already watches that target on that chain)", content: { "application/json": { schema: ref("Error") } } },
        TooLarge: { description: "Request body too large", content: { "application/json": { schema: ref("Error") } } },
        RateLimited: { description: "Rate limited (pager routes add retryAfterSec and a Retry-After header)", content: { "application/json": { schema: ref("Error") } } },
        UpstreamFailed: { description: "A live RPC / upstream read failed; nothing is substituted", content: { "application/json": { schema: ref("Error") } } },
        StorageUnavailable: { description: "Pager storage (Upstash) unavailable or not configured in production; capacity reached", content: { "application/json": { schema: ref("Error") } } },
      },
      schemas: {
        Error: { type: "object", required: ["error"], properties: { error: { type: "string" }, retryAfterSec: { type: "integer" } }, additionalProperties: true },
        Uint: UINT,
        Address: ADDRESS,
        ChainId: CHAIN,
        Band: { type: "string", enum: ["NOMINAL", "ELEVATED", "CRITICAL"] },
        TargetKind: { type: "string", enum: ["wallet", "token", "pool", "escrow", "contract"] },
        BlockRef: { type: "object", required: ["number", "timestamp"], properties: { number: UINT, timestamp: { type: "integer" } } },
        Target: { type: "object", required: ["address", "chainId", "kind", "label"], properties: { address: ADDRESS, chainId: CHAIN, kind: ref("TargetKind"), label: { type: "string" } } },
        Finding: {
          type: "object",
          required: ["severity", "title", "detail", "points"],
          properties: { id: { type: "string" }, severity: { type: "string", enum: ["info", "warn", "critical"] }, title: { type: "string" }, detail: { type: "string" }, points: { type: "integer" }, link: { type: ["object", "null"] } },
        },
        Brief: { type: "object", required: ["text", "source"], properties: { text: { type: "string" }, source: { type: "string", enum: ["deterministic", "0g-compute", "anthropic"] }, model: { type: ["string", "null"] } } },
        ScanResult: {
          type: "object",
          required: ["target", "block", "score", "band", "findings", "brief", "generatedAt"],
          properties: {
            target: ref("Target"),
            block: ref("BlockRef"),
            score: { type: "integer", minimum: 0, maximum: 100 },
            band: ref("Band"),
            findings: { type: "array", items: ref("Finding") },
            token: { type: ["object", "null"] },
            xray: { type: ["object", "null"], description: "Bytecode X-Ray: proxyKind, upgradeAuthority, implementation/admin/beacon, selector hits, degraded flags" },
            pool: { type: ["object", "null"], description: "PoolSnapshot: kind, venue, tokens, reserves, sqrtPriceX96/liquidity, overnight LP and price deltas" },
            flow: { type: ["object", "null"], description: "Overnight token flow, top holders (live balance), holderScan coverage" },
            wallet: { type: ["object", "null"], description: "Approvals (ERC-20 + Permit2), account type (EOA / Safe / smart wallet / 7702), coverage" },
            escrow: { oneOf: [ref("EscrowReport"), { type: "null" }] },
            parity: { oneOf: [ref("ParityReport"), { type: "null" }] },
            brief: ref("Brief"),
            generatedAt: { type: "string", format: "date-time" },
            durationMs: { type: "integer" },
          },
        },
        GuardPreview: {
          type: "object",
          required: ["verdict", "status", "intent", "riskScore", "band", "target", "reasons", "chainId", "blockNumber", "timestamp", "tier"],
          properties: {
            verdict: { type: "string", enum: ["ALLOW", "WARN", "BLOCK"] },
            status: { type: "string", enum: ["complete", "degraded"] },
            retryAfterSec: { type: "integer" },
            scanError: { type: "string", description: "Present when the live scan could not classify the address (HTTP 503, verdict UNKNOWN shown as WARN)" },
            intent: { type: "string", enum: ["trade", "counterparty"] },
            riskScore: { type: ["integer", "null"], description: "null only when scanError is set" },
            band: { oneOf: [ref("Band"), { type: "null" }] },
            target: { type: "object", description: "Target (kind is null when scanError is set)", properties: { address: ADDRESS, chainId: CHAIN, kind: { type: ["string", "null"] }, label: { type: "string" } } },
            reasons: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, title: { type: "string" }, detail: { type: "string" }, points: { type: "integer" }, evidence: { type: ["string", "null"] } } } },
            simulatedSlippage: { type: ["object", "null"], properties: { sellAmountRaw: UINT, sellSymbol: { type: "string" }, receiveSymbol: { type: "string" }, priceImpactBps: { type: "integer" }, note: { type: "string" } } },
            poolDepthWethRaw: { type: ["string", "null"] },
            poolDepth: { type: ["object", "null"] },
            bridgeParity: { type: ["object", "null"] },
            chainId: CHAIN,
            blockNumber: { type: ["string", "null"], description: "uint as decimal string; null only when scanError is set" },
            timestamp: { type: ["string", "null"], format: "date-time" },
            tier: { type: "string", enum: ["preview", "full"] },
          },
        },
        GuardFull: {
          allOf: [
            ref("GuardPreview"),
            {
              type: "object",
              properties: {
                findings: { type: "array", items: ref("Finding") },
                xray: { type: ["object", "null"] },
                pool: { type: ["object", "null"] },
                stress: { type: ["object", "null"], description: "whale5pct and lp50 exit simulations" },
                flow: { type: ["object", "null"] },
                wallet: { type: ["object", "null"] },
                escrow: { type: ["object", "null"] },
                payment: {
                  type: "object",
                  properties: { transaction: { type: "string" }, network: { type: "string" }, payer: ADDRESS, asset: ADDRESS, amountAtomic: UINT, x402Version: { type: "integer", enum: [1, 2] }, explorer: { type: "string", format: "uri" } },
                },
              },
            },
          ],
        },
        PaymentRequiredV1: {
          type: "object",
          description: "x402 v1 PaymentRequired (JSON body of the 402). The v2 equivalent is base64 JSON in the PAYMENT-REQUIRED header (accepts[].network eip155:8453, amount, extensions).",
          required: ["x402Version", "accepts"],
          properties: {
            x402Version: { type: "integer", const: 1 },
            error: { type: "string" },
            accepts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scheme: { type: "string", const: "exact" },
                  network: { type: "string", const: NETWORK_V1 },
                  maxAmountRequired: UINT,
                  resource: { type: "string", format: "uri" },
                  description: { type: "string" },
                  mimeType: { type: "string" },
                  outputSchema: { type: "object" },
                  payTo: ADDRESS,
                  maxTimeoutSeconds: { type: "integer" },
                  asset: { ...ADDRESS, examples: [CONTRACTS.base.usdc] },
                  extra: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } } },
                },
              },
            },
          },
        },
        RevenueReport: {
          type: "object",
          required: ["configured", "asset", "network"],
          properties: {
            configured: { type: "boolean" },
            reason: { type: "string" },
            receiver: ADDRESS,
            asset: ADDRESS,
            network: { type: "string", const: NETWORK_V2 },
            priceAtomic: UINT,
            fromBlock: UINT,
            fromBlockSource: { type: "string", enum: ["env", "auto-24h"] },
            scannedTo: UINT,
            headBlock: UINT,
            catchingUp: { type: "boolean" },
            transfers: { type: "integer" },
            totalAtomic: UINT,
            totalUsdc: { type: "string" },
            uniquePayers: { type: "integer" },
            recent: { type: "array", items: { type: "object", properties: { viaEip3009: { type: ["boolean", "null"] }, submittedBy: { type: ["string", "null"] }, explorer: { type: "string" } }, additionalProperties: true } },
            explorer: { type: "string" },
            ledger: { type: "object", properties: { settlementsRecorded: { type: ["integer", "null"] } } },
            scanError: { type: ["string", "null"] },
            updatedAt: { type: "string" },
          },
        },
        ParityReport: {
          type: "object",
          required: ["base", "robinhood", "lockedOnBase", "rhCirculating", "delta", "verified", "verdict"],
          properties: {
            base: ref("BlockRef"),
            robinhood: ref("BlockRef"),
            lockedOnBase: UINT,
            rhTotalSupply: UINT,
            rhReserve: UINT,
            rhCirculating: UINT,
            delta: UINT,
            deltaSigned: { type: "string", description: "locked − circulating (signed raw)" },
            verified: { type: "boolean" },
            verdict: { type: "string", enum: ["EXACT", "IN_FLIGHT", "OVER_BACKED", "UNBACKED"] },
            pendingPackets: { type: ["integer", "null"], description: "null when the LayerZero nonce reads failed (UNKNOWN)" },
            basePool: { type: ["object", "null"] },
            rhPool: { type: ["object", "null"] },
            spreadBps: { type: ["integer", "null"], description: "+ = VIBES cheaper on Robinhood" },
            cheaperVenue: { type: ["string", "null"], enum: ["base", "robinhood", null] },
            feeDragBps: { type: ["integer", "null"] },
            netEdgeBpsBeforeBridge: { type: ["integer", "null"], description: "|spread| − pool fees" },
            bridgeFeeBps: { type: ["integer", "null"] },
            gasBps: { type: ["integer", "null"] },
            netEdgeBps: { type: ["integer", "null"], description: "|spread| − pool fees − LayerZero fee − gas (null if the fee is unreadable)" },
            arbNotionalWei: UINT,
            gas: { type: "object" },
            bridge: { type: ["object", "null"], description: "OftBridgeReport: lanes[] (direction, nativeFeeWei, feeBreakdown, credit{limit,windowSec,inFlight,headroom,refillPerSec,secondsToFull}, srcPaused, dstPaused, peersOk, DVNs, configMatches, nonces), governance per chain (owner Safe, pauser, delegate)" },
            arb: { type: ["object", "null"], description: "Exact round-trip model at the reference size and the optimal size, creditWaitSec" },
            ethUsd: { type: ["object", "null"], description: "Live ETH/USD from the Base Uniswap v3 WETH/USDC pool" },
            fetchedAt: { type: "string", format: "date-time" },
          },
        },
        EscrowReport: {
          type: "object",
          description: "VibesTranchEscrow live read: state, tranches (10% kickstart + six 15%), challenge windows, LP lock (Proof-of-Lock), Refund Radar, app health, founder GitHub, Origin Capsule. All amounts are decimal strings.",
          required: ["chainId", "address"],
          properties: { chainId: CHAIN, address: ADDRESS, title: { type: ["string", "null"] }, state: { type: "integer" }, stateLabel: { type: "string" }, tranches: { type: "array", items: { type: "object" } } },
          additionalProperties: true,
        },
        VibestarterPulse: {
          type: "object",
          required: ["source", "errors", "fetchedAt"],
          properties: {
            source: { type: "string", enum: ["mcp", "rest", "unavailable"] },
            provenance: { type: ["object", "null"], description: "Vibestarter MCP server, tool, protocolVersion, latencyMs" },
            asOf: { type: ["string", "null"] },
            stats: { type: ["object", "null"] },
            nextUnlock: { type: ["object", "null"] },
            liquidityReconciliation: { type: ["object", "null"], properties: { vibestarterWei: UINT, onchainWei: UINT, deltaWei: { type: "string" }, matches: { type: "boolean" }, positions: { type: "integer" }, locker: ADDRESS, block: UINT, note: { type: "string" } } },
            raises: { type: ["object", "null"] },
            errors: { type: "array", items: { type: "string" } },
            fetchedAt: { type: "string" },
          },
        },
        CopilotReport: {
          type: "object",
          required: ["chainId", "escrow", "gen", "phase", "block", "raiseChecklist", "fetchedAt"],
          properties: {
            chainId: CHAIN,
            escrow: ADDRESS,
            gen: { type: "string", enum: ["v1", "v2", "unknown"] },
            impl: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            phase: { type: "string", enum: ["NOT_FUNDED", "FAILED", "AWAITING_UNLOCK", "AWAITING_REQUEST", "WINDOW_OPEN", "CHALLENGE_PENDING", "AWAITING_CLAIM", "COMPLETED", "FROZEN", "REFUNDING"] },
            phaseDetail: { type: "string" },
            block: { type: "object", properties: { number: UINT, timestamp: { type: "integer" } } },
            oracleTime: { type: "integer" },
            next: { type: ["object", "null"], description: "Next tranche: countdowns, bond, slash at risk, exit quote" },
            challenge: { type: ["object", "null"] },
            votes: { type: ["object", "null"] },
            upheldSnapshot: { type: ["object", "null"] },
            trust: { type: "object" },
            raiseChecklist: { type: "array", items: { type: "object" } },
            wallet: { type: "object", description: "Present with ?wallet=" },
            notes: { type: "array", items: { type: "string" } },
            fetchedAt: { type: "string" },
          },
          additionalProperties: true,
        },
        DryRunResult: {
          type: "object",
          required: ["chainId", "escrow", "applicable", "overrides", "selfCheck", "scenarios", "method", "disclaimer"],
          properties: {
            chainId: CHAIN,
            escrow: ADDRESS,
            gen: { type: "string" },
            applicable: { type: "boolean" },
            reason: { type: ["string", "null"] },
            block: { type: "object" },
            bond: UINT,
            slash: UINT,
            actors: { type: "object" },
            overrides: { type: "array", items: { type: "object" }, maxItems: 5 },
            selfCheck: { type: "string", enum: ["ok", "layout-mismatch", "not-run"] },
            scenarios: { type: "array", items: { type: "object", properties: { outcome: { type: "string", enum: DRY_RUN_OUTCOMES }, steps: { type: "array", items: { type: "object" } } }, additionalProperties: true } },
            elapsedMs: { type: "integer" },
            method: { type: "string", const: "eth_simulateV1" },
            disclaimer: { type: "string" },
          },
          additionalProperties: true,
        },
        EcosystemRow: { type: "object", required: ["key", "chainId", "escrow"], properties: { key: { type: "string" }, chainId: CHAIN, escrow: ADDRESS, title: { type: ["string", "null"] } }, additionalProperties: true },
        EcosystemBoard: {
          type: "object",
          required: ["rows", "totals", "universe", "blocks", "fetchedAt", "buildMs"],
          properties: {
            rows: { type: "array", items: ref("EcosystemRow") },
            totals: { type: "object" },
            universe: { type: "object" },
            blocks: { type: "object", additionalProperties: UINT },
            fetchedAt: { type: "string" },
            buildMs: { type: "integer" },
            cache: { type: "object", properties: { ageSec: { type: "integer" }, stale: { type: "boolean" }, refreshing: { type: "boolean" } } },
            filter: { type: "object" },
          },
        },
        DeskPublic: {
          type: "object",
          required: ["id", "createdAt", "storage", "watchCount", "limits", "policy", "channels"],
          properties: {
            id: { type: "string" },
            createdAt: { type: "integer" },
            label: { type: ["string", "null"] },
            storage: { type: "string", enum: ["upstash", "memory"] },
            watchCount: { type: "integer" },
            limits: { type: "object", properties: { maxWatches: { type: "integer" } } },
            policy: { type: "object", properties: { sleepMode: { type: "string", enum: ["critical-only", "page-all"] } } },
            channels: {
              type: "object",
              properties: {
                telegram: { type: ["object", "null"], properties: { linked: { type: "boolean" }, username: { type: ["string", "null"] }, chatType: { type: "string" }, verified: { type: "boolean" }, disabledReason: { type: ["string", "null"] } } },
                webhook: { type: ["object", "null"], properties: { host: { type: "string" }, kind: { type: "string", enum: ["discord", "slack", "generic"] }, failures: { type: "integer" }, disabledReason: { type: ["string", "null"] }, secret: { type: "string" } } },
              },
            },
          },
        },
        RuleConfigInput: {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string", enum: RULE_TYPES }, enabled: { type: "boolean" }, cooldownMin: { type: "integer" } },
          additionalProperties: true,
          description: "Partial rule config; threshold params per type (e.g. lp_liquidity_drop {dropBps, windowMin}, spread_bps {maxBps}, escrow_window_closing {marksHours}).",
        },
        WatchView: {
          type: "object",
          required: ["id", "chainId", "target", "kind", "label", "enabled", "rules", "status", "state"],
          properties: {
            id: { type: "string" },
            chainId: CHAIN,
            target: ADDRESS,
            kind: ref("TargetKind"),
            label: { type: "string" },
            enabled: { type: "boolean" },
            rules: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string", enum: RULE_TYPES }, enabled: { type: "boolean" } }, additionalProperties: true } },
            meta: { type: "object" },
            status: { type: "string", enum: ["pending", "ok", "alerting", "error"] },
            state: {
              type: "object",
              properties: { lastCheckedAt: { type: ["integer", "null"] }, lastCheckedBlock: { type: ["string", "null"] }, lastError: { type: ["string", "null"] }, lastAlert: { type: ["object", "null"] }, alertCount: { type: "integer" }, metrics: { type: "object", additionalProperties: { type: "string" } } },
            },
            createdAt: { type: "integer" },
            updatedAt: { type: "integer" },
          },
        },
        RuleObservation: { type: "object", properties: { ruleId: { type: "string" }, type: { type: "string" }, fired: { type: "boolean" }, severity: { type: ["string", "null"] }, observed: { type: "string" }, threshold: { type: "string" } }, additionalProperties: true },
        Delivery: { type: "object", properties: { channel: { type: "string" }, ok: { type: "boolean" }, status: { type: ["integer", "null"] }, error: { type: "string" } }, additionalProperties: true },
        SleepPublic: { type: "object", required: ["startedAt", "wakeAt", "policy"], properties: { startedAt: { type: "integer" }, wakeAt: { type: "integer" }, tz: { type: ["string", "null"] }, policy: { type: "string", enum: ["critical-only", "page-all"] }, deferredCount: { type: "integer" }, pagedCount: { type: "integer" } } },
        DigestPayload: {
          type: "object",
          required: ["deskId", "startedAt", "endedAt", "checks", "perWatch", "brief"],
          properties: {
            deskId: { type: "string" },
            startedAt: { type: "integer" },
            endedAt: { type: "integer" },
            tz: { type: ["string", "null"] },
            checks: { type: "integer" },
            blocks: { type: "object" },
            perWatch: { type: "array", items: { type: "object", properties: { watchId: { type: "string" }, label: { type: "string" }, chainId: CHAIN, severity: { type: "string" }, lines: { type: "array", items: { type: "string" } }, actions: { type: "array", items: { type: "object" } } } } },
            pagedCount: { type: "integer" },
            deferredCount: { type: "integer" },
            policy: { type: "string" },
            brief: ref("Brief"),
          },
        },
        TickSummary: {
          type: "object",
          required: ["tickId", "reason", "startedAt", "durationMs", "chains", "hash"],
          properties: {
            tickId: { type: "string" },
            reason: { type: "string" },
            startedAt: { type: "integer" },
            durationMs: { type: "integer" },
            skipped: { type: "string", enum: ["locked", "no-storage", "no-watches"] },
            chains: { type: "object", additionalProperties: { type: "object", properties: { from: UINT, to: UINT, gapBlocks: UINT, ok: { type: "boolean" }, error: { type: "string" } } } },
            watches: { type: "integer" },
            evaluated: { type: "integer" },
            alerts: { type: "integer" },
            deferred: { type: "integer" },
            deliveries: { type: "object", properties: { ok: { type: "integer" }, failed: { type: "integer" } } },
            digests: { type: "integer" },
            scans: { type: "integer" },
            prevHash: { type: ["string", "null"] },
            hash: { type: "string", description: "sha256(prevHash + JSON(summary without hash))" },
          },
        },
        JsonRpcRequest: { type: "object", required: ["jsonrpc", "method"], properties: { jsonrpc: { type: "string", const: "2.0" }, id: { type: ["string", "integer", "null"] }, method: { type: "string" }, params: { type: "object" } } },
        JsonRpcResponse: {
          type: "object",
          required: ["jsonrpc"],
          properties: {
            jsonrpc: { type: "string", const: "2.0" },
            id: { type: ["string", "integer", "null"] },
            result: { type: "object" },
            error: { type: "object", properties: { code: { type: "integer" }, message: { type: "string" } } },
          },
        },
      },
    },
  };
  return json(spec, { cache: "public, s-maxage=300, stale-while-revalidate=3600" });
}

export const OPTIONS = preflight;
