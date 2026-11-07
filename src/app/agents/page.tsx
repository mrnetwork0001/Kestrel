import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { formatUnits } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { Panel, SectionLabel } from "@/components/ui";
import { X402Playground } from "@/components/x402-playground";
import { X402RevenuePanel } from "@/components/x402-revenue-panel";
import { siteUrl } from "@/lib/site";
import { x402Config } from "@/lib/x402";
import { facilitatorInfo } from "@/lib/x402-facilitator";

export const metadata: Metadata = {
  title: "Agents · x402 Pre-Trade Gate · MCP",
  description:
    "Kestrel for autonomous trading agents: GET /api/v1/guard returns ALLOW | WARN | BLOCK, paid per call with x402 (v2 + v1) in Base USDC and settled onchain before the verdict is returned. Streamable HTTP MCP server at /api/mcp, onchain revenue ledger at /api/x402/revenue, and /llms.txt.",
};

// The revenue ledger below reads Base logs; re-render at most once a minute.
export const revalidate = 60;

function Code({ children }: { children: string }) {
  return <pre className="mt-4 max-w-full overflow-x-auto border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2 [-webkit-overflow-scrolling:touch] max-[601px]:p-3 max-[601px]:text-[11px]">{children}</pre>;
}

const FACILITATOR_COPY: Record<string, string> = {
  cdp: "the Coinbase CDP facilitator (KYT/OFAC-screened, gas sponsored, and the route into the CDP x402 Bazaar)",
  payai: "the PayAI facilitator (keyless; the facilitator pays the gas, the agent only needs USDC)",
  custom: "a custom x402 facilitator",
};

export default function AgentsPage() {
  const cfg = x402Config();
  const origin = siteUrl();
  const fac = facilitatorInfo();
  const price = formatUnits(BigInt(cfg.priceAtomic), 6);
  const facCopy = fac ? FACILITATOR_COPY[fac.kind] : "an x402 facilitator";
  return (
    <div className="mx-auto max-w-[1100px] overflow-x-clip px-4 pb-10 pt-12 max-[901px]:pt-8">
      <SectionLabel n="07">For autonomous agents</SectionLabel>
      <h1 className="mt-4 font-serif text-[34px] leading-[1.06] text-ink sm:text-[48px] sm:leading-[1.04]">A pre-trade firewall your agent can pay for per call.</h1>
      <p className="mt-5 max-w-3xl text-[15px] leading-relaxed text-ink-2">
        Agents swap at machine speed and get rugged at machine speed. Before an agent touches a token or pool on Base or Robinhood Chain, it asks Kestrel. The
        answer is a machine-readable <span className="mono text-ink">ALLOW | WARN | BLOCK</span> verdict built from live bytecode, proxy slots, owner posture, pool depth,
        overnight deltas and bridge parity. A free preview tier is always on. Full verdicts cost {price} USDC per call on Base, paid with the open{" "}
        <a className="text-phosphor hover:underline" href="https://github.com/x402-foundation/x402" target="_blank" rel="noreferrer">x402</a> HTTP 402 standard: no API keys, no accounts.
      </p>

      <section className="mt-12 grid gap-6 max-[901px]:mt-8 max-[901px]:gap-3 md:grid-cols-2 lg:grid-cols-4">
        {[
          ["GET /api/v1/guard", "Pre-trade verdict. mode=preview free; mode=full via x402."],
          ["POST /api/mcp", "Streamable HTTP MCP server with 4 read-only tools."],
          ["GET /api/x402/revenue", "Onchain proof of every x402 payment received."],
          ["GET /llms.txt", "The whole product and API surface in one fetch."],
        ].map(([k, v]) => (
          <div key={k} className="panel min-w-0 p-4">
            <p className="mono text-[13px] text-phosphor [overflow-wrap:anywhere]">{k}</p>
            <p className="mt-2 text-[13px] text-ink-3">{v}</p>
          </div>
        ))}
      </section>

      <section className="mt-14 max-[901px]:mt-10">
        <SectionLabel>How a paid call settles</SectionLabel>
        <ol className="mt-4 grid gap-3 text-[13px] leading-relaxed text-ink-2 md:grid-cols-2">
          {[
            [
              "402 challenge",
              `GET /api/v1/guard?mode=full without payment answers HTTP 402. The x402 v2 PaymentRequired is in the base64 PAYMENT-REQUIRED header (network eip155:8453); the legacy v1 form is in the JSON body (network "base"). Both quote ${price} USDC (${cfg.priceAtomic} atomic units) to the same receiver.`,
            ],
            [
              "Signed authorization",
              "The agent signs an EIP-3009 TransferWithAuthorization for the exact price and retries with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Kestrel never holds keys or funds. The signature is the payment.",
            ],
            [
              "Verify → scan → settle",
              `Kestrel checks the amount, recipient and time window, verifies the signature through ${facCopy}, runs the full scan, then has the facilitator settle the transfer on Base. The verdict comes back only after settlement, with a PAYMENT-RESPONSE (or X-PAYMENT-RESPONSE) receipt carrying the transaction hash. If the scan fails, nothing is settled and the same header can be retried.`,
            ],
            [
              "Single-use payments",
              "Each (payer, nonce) authorization is claimed with an atomic SET NX lock before verification, checked against USDC.authorizationState onchain, and each settlement transaction is delivered once. Replaying a header, even in parallel, returns 402 payment_already_used or payment_in_flight, never a second verdict.",
            ],
          ].map(([t, d], i) => (
            <li key={t} className="panel min-w-0 p-4">
              <p className="mono text-[12px] text-phosphor">
                {String(i + 1).padStart(2, "0")} · {t}
              </p>
              <p className="mt-2 text-ink-3">{d}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-ink-3">
          Discovery: every 402 carries x402 Bazaar metadata (<span className="mono">extensions.bazaar</span> input/output schema, plus <span className="mono">outputSchema</span> for v1
          clients), and Kestrel re-attaches it to every settle. After its first CDP-settled call the endpoint is listed in the{" "}
          <a className="text-phosphor hover:underline" href="https://docs.cdp.coinbase.com/x402/seller/get-discovered" target="_blank" rel="noreferrer">
            x402 Bazaar
          </a>{" "}
          catalog that agents search. Payments settle on Base only; scans cover Base and Robinhood Chain.
        </p>
      </section>

      <section className="mt-14 max-[901px]:mt-10">
        <SectionLabel>Live x402 handshake playground</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] text-ink-3">
          These buttons hit this deployment&apos;s real endpoint. Step 2 returns the actual HTTP 402. Step 3 asks your wallet to sign a real EIP-3009{" "}
          <span className="mono">TransferWithAuthorization</span> for {price} USDC (x402 v2 by default, v1 selectable). The server verifies it, runs the scan, settles it onchain and only
          then returns the verdict and the Basescan link.
        </p>
        <div className="mt-5 min-w-0">
          <X402Playground defaultAddress={CONTRACTS.base.vibesToken} />
        </div>
        {!cfg.receiver && (
          <p className="mt-3 mono text-[11px] text-warn">
            This deployment has no X402_RECEIVER_ADDRESS set, so step 2 honestly returns 501 (paid tier not configured) instead of a 402. Step 1 works.
          </p>
        )}
      </section>

      <section className="mt-14 min-w-0 max-[901px]:mt-10">
        <SectionLabel>Revenue, proven onchain</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] text-ink-3">
          Every number here is read from Base: USDC <span className="mono">Transfer</span> logs into the receiver, scanned in 50,000-block windows. The server&apos;s own delivery
          ledger sits beside it so the two can be compared.
        </p>
        <div className="mt-5">
          <Suspense
            fallback={
              <Panel title="x402 revenue ledger · onchain" n="C" className="min-w-0">
                <p className="mono text-[12px] text-ink-3">Reading Base USDC logs…</p>
              </Panel>
            }
          >
            <X402RevenuePanel />
          </Suspense>
        </div>
      </section>

      <section className="mt-14 grid gap-6 max-[901px]:mt-10 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel title="Guard request / response" n="A" className="min-w-0">
          <Code>{`GET ${origin}/api/v1/guard?address=0x…&chainId=8453

200 OK
{
  "verdict": "ALLOW" | "WARN" | "BLOCK",
  "riskScore": 0-100,           // NOMINAL <30 · ELEVATED <65 · CRITICAL
  "band": "NOMINAL",
  "reasons": [{ "severity": "warn", "title": "…" }],
  "simulatedSlippage": { "priceImpactBps": 98, … },
  "poolDepthWethRaw": "10052414182037559293",
  "bridgeParity": { "verified": true, "spreadBps": -93 },
  "blockNumber": "…", "chainId": 8453, "tier": "preview"
}`}</Code>
        </Panel>
        <Panel title="x402 payment flow (v2 + v1)" n="B" className="min-w-0">
          <Code>{`GET /api/v1/guard?address=0x…&mode=full
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
  base64({ success, transaction, network, payer })`}</Code>
        </Panel>
      </section>

      <section className="mt-14 min-w-0 max-[901px]:mt-10">
        <SectionLabel>Discovery &amp; validation</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] text-ink-3">
          Check the 402 against Coinbase&apos;s keyless x402 validator, then look the service up in the Bazaar catalog once a CDP-settled call has gone through.
        </p>
        <Code>{`curl -s -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \\
  -H 'content-type: application/json' \\
  -d '{"resource":"${origin}/api/v1/guard?mode=full","method":"GET"}'

curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=robinhood%20chain%20pre-trade%20security&limit=5"`}</Code>
      </section>

      <section className="mt-14 max-[901px]:mt-10">
        <SectionLabel>MCP server</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] text-ink-3">Add Kestrel to Claude Code, Claude Desktop or any MCP client over Streamable HTTP. All tools are read-only and hit mainnet live.</p>
        <div className="mt-5 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Code>{`# Claude Code
claude mcp add --transport http kestrel ${origin}/api/mcp

# .mcp.json
{
  "mcpServers": {
    "kestrel": { "type": "http", "url": "${origin}/api/mcp" }
  }
}`}</Code>
          <div className="panel divide-y divide-white/[0.06]">
            {[
              ["scan_contract", "{ address, chainId } → guard verdict"],
              ["check_bridge_parity", "{} → OFT 1:1 invariant + spread"],
              ["simulate_exit", "{ address, chainId, sellBpsOfReserve, lpPullBps, whaleDumpBpsOfSupply }"],
              ["inspect_vibestarter_escrow", "{ address?, chainId } → tranche timeline & challenge windows"],
            ].map(([n, d]) => (
              <div key={n} className="p-3">
                <p className="mono text-[12px] text-phosphor [overflow-wrap:anywhere]">{n}</p>
                <p className="mt-1 mono text-[11px] text-ink-3 [overflow-wrap:anywhere]">{d}</p>
              </div>
            ))}
          </div>
        </div>
        <Code>{`curl -s -X POST ${origin}/api/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"check_bridge_parity","arguments":{}}}'`}</Code>
        <p className="mt-4 text-[12px] text-ink-3 [overflow-wrap:anywhere]">
          Kestrel also consumes Vibestarter&apos;s own MCP server (<span className="mono">https://app.vibestarter.xyz/mcp</span>) and public campaigns API for Backer Shield enrichment. Machine spec:{" "}
          <a href="/api/openapi.json" className="text-phosphor hover:underline">/api/openapi.json</a> · <a href="/llms.txt" className="text-phosphor hover:underline">/llms.txt</a> ·{" "}
          <Link href="/how-it-works" className="text-phosphor hover:underline">architecture</Link>
        </p>
      </section>
    </div>
  );
}
