import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { formatUnits } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { InkLink, SkeletonRows } from "@/components/editorial";
import { C, Chapter, DataList, DocActions, DocGrid, PageMasthead, Plate, Procedure } from "@/components/page-masthead";
import { X402Playground } from "@/components/x402-playground";
import { X402RevenuePanel } from "@/components/x402-revenue-panel";
import { siteUrl } from "@/lib/site";
import { x402Config } from "@/lib/x402";
import { facilitatorInfo } from "@/lib/x402-facilitator";

export const metadata: Metadata = {
  title: "Agents · x402 Pre-Trade Gate · MCP",
  description:
    "Kestrel for autonomous trading agents: GET /api/v1/guard returns ALLOW | WARN | BLOCK, paid per call with x402 (v2 + v1) in Base USDC and settled onchain before the verdict is returned. Streamable HTTP MCP server at /api/mcp, onchain revenue ledger at /api/x402/revenue, and /llms.txt.",
  alternates: { canonical: "/agents" },
};

// The revenue ledger below reads Base logs; re-render at most once a minute.
export const revalidate = 60;

const FACILITATOR_COPY: Record<string, string> = {
  cdp: "the Coinbase CDP facilitator (KYT/OFAC-screened, gas sponsored, and the route into the CDP x402 Bazaar)",
  payai: "the PayAI facilitator (keyless; the facilitator pays the gas, the agent only needs USDC)",
  custom: "a custom x402 facilitator",
};

const TOC = [
  { id: "guard", label: "GET /api/v1/guard" },
  { id: "x402", label: "The 402 flow" },
  { id: "playground", label: "Playground" },
  { id: "revenue", label: "Revenue ledger" },
  { id: "mcp", label: "POST /api/mcp" },
  { id: "llms", label: "GET /llms.txt" },
  { id: "discovery", label: "Discovery" },
];

const MCP_TOOLS: { label: string; value: string; sub?: string }[] = [
  { label: "scan_contract", value: "{ address, chainId, intent? } → guard verdict" },
  { label: "check_bridge_parity", value: "{} → OFT 1:1 invariant, signed verdict and spread" },
  { label: "simulate_exit", value: "{ address, chainId, sellBpsOfReserve, lpPullBps, whaleDumpBpsOfSupply }" },
  { label: "inspect_vibestarter_escrow", value: "{ address?, chainId } → tranche timeline and challenge windows" },
  { label: "challenge_copilot", value: "{ escrow, chainId, wallet? } → phase, 72h window and backer readiness" },
  { label: "challenge_dry_run", value: "{ escrow, outcomes? } → real escrow bytecode through eth_simulateV1" },
  { label: "ecosystem_health", value: "{ chainId?, escrow? } → every Vibestarter launch, live health board" },
  { label: "vibestarter_pulse", value: "{} → platform figures from Vibestarter's own MCP server" },
  { label: "create_watch", value: "Night-Shift Pager watch", sub: "desk key as a tool argument; opens a desk and returns its key once if you have none" },
  { label: "list_watches", value: "Your desk's pager watches", sub: "desk key required" },
  { label: "delete_watch", value: "Removes a pager watch", sub: "desk key required" },
];

export default function AgentsPage() {
  const cfg = x402Config();
  const origin = siteUrl();
  const fac = facilitatorInfo();
  const price = formatUnits(BigInt(cfg.priceAtomic), 6);
  const facCopy = fac ? FACILITATOR_COPY[fac.kind] : "an x402 facilitator";
  const methodKicker = "!normal-case !tracking-normal text-[13px]";
  return (
    <article className="min-w-0 overflow-x-clip">
      <PageMasthead
        kicker="For autonomous agents"
        title={["A pre-trade firewall", "your agent pays for per call."]}
        dek={`Before an agent touches a token or pool, it asks Kestrel. ALLOW, WARN or BLOCK, from live bytecode, pools and bridge parity. ${price} USDC per full verdict on Base.`}
        meta={
          <>
            <span>x402 v2 + v1</span>
            <span className="text-ink-3">·</span>
            <span>MCP Streamable HTTP</span>
            <span className="text-ink-3">·</span>
            <span>No API keys, no accounts</span>
          </>
        }
      />

      <DocGrid toc={TOC}>
        <Chapter
          id="guard"
          kicker="GET | POST /api/v1/guard"
          kickerClass={methodKicker}
          tone="phosphor"
          title={["The pre-trade verdict"]}
          wide={
            <Plate lines label={<><span>response · 200 OK</span><span>X-Kestrel-Guard-Status: complete | degraded</span></>}>{`GET ${origin}/api/v1/guard?address=0x…&chainId=8453&intent=trade

{
  "verdict": "ALLOW" | "WARN" | "BLOCK",
  "riskScore": 0-100 | null,    // null when degraded with scanError
  "band": "NOMINAL" | "ELEVATED" | "CRITICAL" | null,
  "status": "complete" | "degraded",
  "retryAfterSec": 15,          // only when degraded
  "intent": "trade",
  "reasons": [{ "severity": "warn", "title": "…" }],
  "simulatedSlippage": { "priceImpactBps": 98, … },
  "poolDepthWethRaw": "10052414182037559293",
  "bridgeParity": { "verified": true, "verdict": "EXACT", "pendingPackets": 0, "spreadBps": -93, "netEdgeBps": … },
  "blockNumber": "…", "chainId": 8453, "tier": "preview"
}`}</Plate>
          }
        >
          <p>
            A machine-readable verdict built from live bytecode, proxy slots, owner posture, pool depth, overnight deltas and bridge parity on Base or Robinhood Chain. The
            free preview tier is always on. <C>POST</C> takes the same fields as a JSON body.
          </p>
          <DataList
            rows={[
              { label: "address", value: "Token, pool, wallet or escrow (0x…). The zero address is rejected with 400." },
              { label: "chainId", value: "8453 (Base) or 4663 (Robinhood Chain). Anything else is 400." },
              { label: "mode", value: <><C>preview</C> (free, default) or <C>full</C> (x402, {price} USDC).</> },
              { label: "intent", value: <><C>trade</C> (default: a token or pool you will trade or approve) or <C>counterparty</C> (a wallet you will send to). A smart-wallet target is BLOCKed for trade intent.</> },
            ]}
          />
          <p>
            When a live read fails part-way, the verdict comes back as WARN with <C>status: &quot;degraded&quot;</C> and <C>retryAfterSec</C>. When the scan cannot classify the
            address at all, the answer is HTTP 503 with <C>Retry-After</C>, never a guessed verdict.
          </p>
        </Chapter>

        <Chapter
          id="x402"
          kicker="HTTP 402 · Base USDC"
          tone="phosphor"
          title={["How a paid call settles"]}
          side={
            <>
              <p className="t-kicker">Settles in</p>
              <p className="mt-2 text-ink">Base USDC</p>
              <p className="mt-1 [overflow-wrap:anywhere]">{CONTRACTS.base.usdc}</p>
              <p className="mt-3">
                {price} USDC · {cfg.priceAtomic} atomic units per full verdict
              </p>
            </>
          }
          wide={
            <div className="space-y-8">
              <Procedure
                steps={[
                  {
                    title: "402 challenge",
                    body: `GET /api/v1/guard?mode=full without payment answers HTTP 402. The x402 v2 PaymentRequired is in the base64 PAYMENT-REQUIRED header (network eip155:8453); the legacy v1 form is in the JSON body (network "base"). Both quote ${price} USDC to the same receiver.`,
                  },
                  {
                    title: "Signed authorization",
                    body: "The agent signs an EIP-3009 TransferWithAuthorization for the exact price and retries with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Kestrel never holds keys or funds. The signature is the payment.",
                  },
                  {
                    title: "Verify, scan, settle",
                    body: `Kestrel checks the amount, recipient and time window, verifies the signature through ${facCopy}, runs the full scan, then has the facilitator settle the transfer on Base. The verdict comes back only after settlement, with a PAYMENT-RESPONSE (or X-PAYMENT-RESPONSE) receipt carrying the transaction hash. If the scan fails, nothing is settled and the same header can be retried.`,
                  },
                  {
                    title: "Single-use payments",
                    body: "Each (payer, nonce) authorization is claimed with an atomic SET NX lock before verification, checked against USDC.authorizationState onchain, and each settlement transaction is delivered once. Replaying a header, even in parallel, returns 402 payment_already_used or payment_in_flight, never a second verdict.",
                  },
                ]}
              />
              <Plate lines label={<><span>x402 payment flow</span><span>v2 + v1</span></>}>{`GET /api/v1/guard?address=0x…&mode=full
← 402
  PAYMENT-REQUIRED: base64({ "x402Version": 2,
    "resource": { "url": "${origin}/api/v1/guard?mode=full", … },
    "accepts": [{ "scheme": "exact", "network": "eip155:8453",
      "asset": "${CONTRACTS.base.usdc}",
      "amount": "${cfg.priceAtomic}",   // ${price} USDC
      "payTo": "${cfg.receiver ?? "<X402_RECEIVER_ADDRESS>"}",
      "maxTimeoutSeconds": ${cfg.maxTimeoutSeconds},
      "extra": { "name": "USD Coin", "version": "2" } }],
    "extensions": { "bazaar": { "info": …, "schema": … } } })
  body: { "x402Version": 1, "accepts": [{ "network": "base",
    "maxAmountRequired": "${cfg.priceAtomic}", … }] }

→ retry, v2:  PAYMENT-SIGNATURE: base64({ x402Version: 2,
    accepted, payload: { signature, authorization } })
→ retry, v1:  X-PAYMENT: base64({ x402Version: 1,
    scheme, network, payload: { signature, authorization } })

  verify (facilitator) → full scan → settle on Base
← 200 + verdict + payment.transaction
  PAYMENT-RESPONSE (v2) | X-PAYMENT-RESPONSE (v1):
  base64({ success, transaction, network, payer })`}</Plate>
            </div>
          }
        >
          <p>
            Full verdicts are paid with the open <InkLink href="https://github.com/x402-foundation/x402" external>x402</InkLink> HTTP 402 standard. Payments settle on Base
            only; scans cover Base and Robinhood Chain.
          </p>
        </Chapter>

        <Chapter
          id="playground"
          kicker="Simulate Agent x402 Call"
          tone="phosphor"
          title={["Run the handshake yourself."]}
          wide={
            <div className="min-w-0">
              <X402Playground defaultAddress={CONTRACTS.base.vibesToken} />
              {!cfg.receiver && (
                <p className="mt-3 t-meta !text-warn">
                  This deployment has no X402_RECEIVER_ADDRESS set, so step 2 honestly returns 501 (paid tier not configured) instead of a 402. Step 1 works.
                </p>
              )}
            </div>
          }
        >
          <p>
            These buttons hit this deployment&apos;s real endpoint. Step 2 returns the actual HTTP 402. Step 3 asks your wallet to sign a real EIP-3009{" "}
            <C>TransferWithAuthorization</C> for {price} USDC (x402 v2 by default, v1 selectable). The server verifies it, runs the scan, settles it onchain and only then
            returns the verdict and the Basescan link.
          </p>
        </Chapter>

        <Chapter
          id="revenue"
          kicker="GET /api/x402/revenue"
          kickerClass={methodKicker}
          tone="phosphor"
          title={["Revenue, proven onchain"]}
          wide={
            <Suspense fallback={<SkeletonRows rows={4} caption="Reading Base USDC logs" />}>
              <X402RevenuePanel />
            </Suspense>
          }
        >
          <p>
            Every number here is read from Base: USDC <C>Transfer</C> logs into the receiver, scanned in 50,000-block windows. The server&apos;s own delivery ledger sits beside it
            so the two can be compared.
          </p>
        </Chapter>

        <Chapter
          id="mcp"
          kicker="POST /api/mcp"
          kickerClass={methodKicker}
          tone="phosphor"
          title={["An MCP server with 11 tools"]}
          wide={
            <div className="grid gap-6 min-[1101px]:grid-cols-2 [&>*]:min-w-0">
              <Plate label={<><span>install</span><span>Streamable HTTP</span></>}>{`# Claude Code
claude mcp add --transport http kestrel ${origin}/api/mcp

# .mcp.json
{
  "mcpServers": {
    "kestrel": { "type": "http", "url": "${origin}/api/mcp" }
  }
}`}</Plate>
              <Plate lines label={<><span>tools/call</span><span>JSON-RPC 2.0</span></>}>{`curl -s -X POST ${origin}/api/mcp \\
  -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"check_bridge_parity","arguments":{}}}'`}</Plate>
            </div>
          }
        >
          <p>
            Add Kestrel to Claude Code, Claude Desktop or any MCP client. Eight tools are read-only and hit mainnet live; three manage Night-Shift Pager watches with a desk key
            passed as a tool argument. Browser requests from other origins get 403.
          </p>
          <DataList dense rows={MCP_TOOLS} />
        </Chapter>

        <Chapter id="llms" kicker="GET /llms.txt" kickerClass={methodKicker} tone="phosphor" title={["The whole surface in one fetch"]}>
          <p>
            <InkLink href="/llms.txt" external>/llms.txt</InkLink> describes every page, endpoint and MCP tool in plain text for language models.{" "}
            <InkLink href="/api/openapi.json" external>/api/openapi.json</InkLink> is the OpenAPI 3.1 spec. Kestrel itself consumes Vibestarter&apos;s MCP server (
            <C>https://app.vibestarter.xyz/mcp</C>) and public campaigns API for Backer Shield enrichment.
          </p>
        </Chapter>

        <Chapter
          id="discovery"
          kicker="x402 Bazaar"
          tone="phosphor"
          title={["Discovery and validation"]}
          wide={
            <Plate label={<><span>validate · discover</span><span>Coinbase CDP</span></>}>{`curl -s -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \\
  -H 'content-type: application/json' \\
  -d '{"resource":"${origin}/api/v1/guard?mode=full","method":"GET"}'

curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=robinhood%20chain%20pre-trade%20security&limit=5"`}</Plate>
          }
        >
          <p>
            Every 402 carries x402 Bazaar metadata (<C>extensions.bazaar</C> input and output schema, plus <C>outputSchema</C> for v1 clients), and Kestrel re-attaches it to
            every settle. After its first CDP-settled call the endpoint is listed in the{" "}
            <InkLink href="https://docs.cdp.coinbase.com/x402/seller/get-discovered" external>x402 Bazaar</InkLink> catalog that agents search. Check the 402 against
            Coinbase&apos;s keyless validator, then look the service up.
          </p>
        </Chapter>

        <DocActions>
          <Link href="/app" className="btn-primary press">
            LAUNCH APP
          </Link>
          <Link href="/how-it-works" className="btn-ghost press">
            Architecture
          </Link>
        </DocActions>
      </DocGrid>
    </article>
  );
}
