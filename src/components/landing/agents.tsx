import { Suspense } from "react";
import { CONTRACTS } from "@/config/contracts";
import { InkLink, Kicker, Wrap } from "@/components/editorial";
import { rv, SplitWords } from "@/components/motion";
import { getGuard } from "./data";
import { tidy } from "./shared";
import { TerminalPlate, type TerminalLine, type TerminalTone } from "./terminal-plate";

/** The 11 tools /api/mcp lists on tools/list (src/app/api/mcp/route.ts). */
const MCP_TOOLS = [
  "scan_contract",
  "check_bridge_parity",
  "simulate_exit",
  "inspect_vibestarter_escrow",
  "challenge_copilot",
  "challenge_dry_run",
  "ecosystem_health",
  "vibestarter_pulse",
  "create_watch",
  "list_watches",
  "delete_watch",
] as const;

const PLATE_TITLE = "[ LIVE // GUARD · $VIBES ]";
const GUARD_CMD = `$ curl "/api/v1/guard?address=${CONTRACTS.base.vibesToken}&chainId=8453"`;

const ENDPOINTS: { k: string; v: string }[] = [
  { k: "GET /api/v1/guard", v: "ALLOW, WARN or BLOCK with risk score and reasons" },
  { k: "POST /api/mcp", v: `Streamable HTTP MCP server, ${MCP_TOOLS.length} tools` },
  { k: "/llms.txt", v: "The whole product and API surface in one fetch" },
];

/** S4 · For agents: full-bleed band. Copy (5 cols) + the live guard verdict for $VIBES on a terminal plate (7 cols). */
export function AgentsSection() {
  return (
    <Wrap band id="agents" className="sec-y">
      <div className="grid gap-12 min-[901px]:grid-cols-12 min-[901px]:gap-6">
        <div className="min-w-0 min-[901px]:col-span-5 min-[901px]:pr-6">
          <Kicker tone="phosphor" d={0}>
            For autonomous agents
          </Kicker>
          <SplitWords as="h2" className="t-h2 mt-5" parts={["Agents ask Kestrel", "br", "before they swap."]} d={140} />
          <p className="t-body mt-5 max-w-[44ch]" {...rv(0, "up", 300)}>
            Free preview verdicts. Full verdicts pay 0.01 USDC on Base over HTTP 402 (x402). Or mount Kestrel as an MCP server.
          </p>
          <dl className="mt-10 divide-y divide-hair border-y border-hair">
            {ENDPOINTS.map((e, i) => (
              <div key={e.k} className="grid gap-1 py-4 min-[601px]:grid-cols-[150px_minmax(0,1fr)] min-[601px]:gap-4" {...rv(i, "up", 380)}>
                <dt className="mono text-[13px] text-ink">{e.k}</dt>
                <dd className="text-[15px] leading-snug text-ink-2">{e.v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-2 text-[15px] text-ink" {...rv(3, "up", 380)}>
            <InkLink href="/agents">Agent docs &amp; live x402 playground</InkLink>
            <a href="/llms.txt" className="ink-target mono text-[14px]">
              <span className="ink-line">/llms.txt</span>
            </a>
          </div>
          {/* Plain links to raw live output (no JS needed): crawlers and judges can verify the product directly. */}
          <p className="t-meta mt-6 max-w-[52ch]" {...rv(4, "up", 380)}>
            Verify the raw output:{" "}
            <a href={`/api/v1/guard?address=${CONTRACTS.base.vibesToken}&chainId=8453`} className="ink-target mono">
              <span className="ink-line">guard verdict JSON</span>
            </a>
            {" · "}
            <a href="/api/x402/revenue" className="ink-target mono">
              <span className="ink-line">x402 revenue ledger</span>
            </a>{" "}
            (real USDC settlements on Base){" · "}
            <a href="/api/openapi.json" className="ink-target mono">
              <span className="ink-line">OpenAPI</span>
            </a>
          </p>
        </div>
        <div className="min-w-0 min-[901px]:col-span-7" {...rv(0, "up", 200)}>
          <Suspense
            fallback={<TerminalPlate busy title={PLATE_TITLE} lines={[{ text: GUARD_CMD, tone: "ink" }, { text: "reading live verdict", tone: "meta" }]} />}
          >
            <AgentSample />
          </Suspense>
        </div>
      </div>
    </Wrap>
  );
}

const VERDICT_TONE: Record<string, TerminalTone> = { ALLOW: "phosphor", WARN: "warn", BLOCK: "crit" };

/** The real preview response of /api/v1/guard for Base $VIBES, as plain-text terminal lines. */
async function AgentSample() {
  const guard = await getGuard();
  const lines: TerminalLine[] = [{ text: GUARD_CMD, tone: "ink" }];
  let meta: string | undefined;
  if (guard) {
    // riskScore / band are null when the guard is degraded (scan could not run); JSON shows them as null, never a fake 0.
    const body = JSON.stringify(
      { verdict: guard.verdict, status: guard.status, riskScore: guard.riskScore, band: guard.band, blockNumber: guard.blockNumber, reasons: guard.reasons.map((r) => r.title) },
      null,
      2
    );
    const tone = VERDICT_TONE[guard.verdict] ?? "ink";
    for (const text of tidy(body).split("\n")) lines.push({ text, tone: text.trimStart().startsWith('"verdict"') ? tone : "meta" });
    if (guard.blockNumber != null) meta = `BLOCK ${Number(guard.blockNumber).toLocaleString("en-US")}`;
  } else {
    lines.push({ text: "// live guard read unavailable at this block. Call the endpoint for a fresh verdict.", tone: "warn" });
  }
  lines.push({ text: "", tone: "meta" });
  lines.push({ text: `$ curl -X POST /api/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`, tone: "ink" });
  lines.push({ text: `# ${MCP_TOOLS.length} tools`, tone: "meta" });
  lines.push({ text: MCP_TOOLS.join(" · "), tone: "phosphor" });
  return <TerminalPlate title={PLATE_TITLE} meta={meta} lines={lines} />;
}

/** @deprecated name kept so page.tsx keeps compiling until landing-top switches to AgentsSection. */
export const AgentsPanel = AgentsSection;
