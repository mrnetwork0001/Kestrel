import type { Metadata } from "next";
import Link from "next/link";
import { CONTRACTS } from "@/config/contracts";
import { Panel, SectionLabel } from "@/components/ui";
import { X402Playground } from "@/components/x402-playground";
import { siteUrl } from "@/lib/site";
import { x402Config } from "@/lib/x402";

export const metadata: Metadata = {
  title: "Agents · x402 Pre-Trade Gate · MCP",
  description: "Kestrel for autonomous trading agents: GET /api/v1/guard returns ALLOW | WARN | BLOCK with HTTP 402 x402 Base USDC payments, a Streamable HTTP MCP server at /api/mcp, and /llms.txt.",
};

function Code({ children }: { children: string }) {
  return <pre className="mt-4 overflow-x-auto border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2">{children}</pre>;
}

export default function AgentsPage() {
  const cfg = x402Config();
  const origin = siteUrl();
  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-10 pt-12">
      <SectionLabel n="07">For autonomous agents</SectionLabel>
      <h1 className="mt-4 font-serif text-[48px] leading-[1.04] text-ink">A pre-trade firewall your agent can pay for per call.</h1>
      <p className="mt-5 max-w-3xl text-[15px] leading-relaxed text-ink-2">
        Agents swap at machine speed and get rugged at machine speed. Before an agent touches a token or pool on Base or Robinhood Chain, it asks Kestrel. The
        answer is a machine-readable <span className="mono text-ink">ALLOW | WARN | BLOCK</span> verdict built from live bytecode, proxy slots, owner posture, pool depth,
        overnight deltas and bridge parity. A free preview tier is always on; full verdicts are paid per call in USDC on Base using the open{" "}
        <a className="text-phosphor hover:underline" href="https://github.com/coinbase/x402" target="_blank" rel="noreferrer">x402</a> HTTP 402 standard — no API keys, no accounts.
      </p>

      <section className="mt-12 grid gap-6 md:grid-cols-3">
        {[
          ["GET /api/v1/guard", "Pre-trade verdict. mode=preview free; mode=full via x402."],
          ["POST /api/mcp", "Streamable HTTP MCP server with 4 read-only tools."],
          ["GET /llms.txt", "The whole product and API surface in one fetch."],
        ].map(([k, v]) => (
          <div key={k} className="panel p-4">
            <p className="mono text-[13px] text-phosphor">{k}</p>
            <p className="mt-2 text-[13px] text-ink-3">{v}</p>
          </div>
        ))}
      </section>

      <section className="mt-14">
        <SectionLabel>Live x402 handshake playground</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] text-ink-3">
          These buttons hit this deployment&apos;s real endpoint. Step 2 returns the actual HTTP 402 payment requirements. Step 3 asks your wallet to sign a real EIP-3009{" "}
          <span className="mono">TransferWithAuthorization</span> for {Number(cfg.priceAtomic) / 1e6} USDC; the server verifies the signature, nonce and balance onchain
          {cfg.facilitator ? " and settles through the configured facilitator." : ". No facilitator is configured here, so the authorization is verified but never submitted — no funds move."}
        </p>
        <div className="mt-5">
          <X402Playground defaultAddress={CONTRACTS.base.vibesToken} />
        </div>
        {!cfg.receiver && <p className="mt-3 mono text-[11px] text-warn">This deployment has no X402_RECEIVER_ADDRESS set, so step 2 returns 501 instead of 402.</p>}
      </section>

      <section className="mt-14 grid gap-6 lg:grid-cols-2">
        <Panel title="Guard request / response" n="A">
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
        <Panel title="x402 payment flow" n="B">
          <Code>{`GET /api/v1/guard?…&mode=full
← 402 { "x402Version": 1, "accepts": [{
    "scheme": "exact", "network": "base",
    "maxAmountRequired": "${cfg.priceAtomic}",   // ${Number(cfg.priceAtomic) / 1e6} USDC
    "asset": "${CONTRACTS.base.usdc}",
    "payTo": "${cfg.receiver ?? "<X402_RECEIVER_ADDRESS>"}",
    "extra": { "name": "USD Coin", "version": "2" } }] }

→ retry with  X-PAYMENT: base64({ x402Version, scheme,
    network, payload: { signature, authorization } })
← 200 + X-PAYMENT-RESPONSE`}</Code>
        </Panel>
      </section>

      <section className="mt-14">
        <SectionLabel>MCP server</SectionLabel>
        <p className="mt-3 max-w-3xl text-[13px] text-ink-3">Add Kestrel to Claude Code, Claude Desktop or any MCP client over Streamable HTTP. All tools are read-only and hit mainnet live.</p>
        <div className="mt-5 grid gap-6 lg:grid-cols-2">
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
                <p className="mono text-[12px] text-phosphor">{n}</p>
                <p className="mt-1 mono text-[11px] text-ink-3">{d}</p>
              </div>
            ))}
          </div>
        </div>
        <Code>{`curl -s -X POST ${origin}/api/mcp -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"check_bridge_parity","arguments":{}}}'`}</Code>
        <p className="mt-4 text-[12px] text-ink-3">
          Kestrel also consumes Vibestarter&apos;s own MCP server (<span className="mono">https://app.vibestarter.xyz/mcp</span>) and public campaigns API for Backer Shield enrichment. Machine spec:{" "}
          <a href="/api/openapi.json" className="text-phosphor hover:underline">/api/openapi.json</a> · <a href="/llms.txt" className="text-phosphor hover:underline">/llms.txt</a> ·{" "}
          <Link href="/how-it-works" className="text-phosphor hover:underline">architecture</Link>
        </p>
      </section>
    </div>
  );
}
