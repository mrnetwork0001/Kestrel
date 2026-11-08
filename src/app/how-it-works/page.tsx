import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CONTRACTS } from "@/config/contracts";
import { InkLink } from "@/components/editorial";
import { Led } from "@/components/motion";
import { C, Chapter, DocActions, DocGrid, H3, PageMasthead, Plate, Procedure } from "@/components/page-masthead";
import { AddrLink } from "@/components/ui";
import { explorerBlock } from "@/lib/format";
import { getRibbonTelemetryCached } from "@/lib/ribbon";

export const metadata: Metadata = {
  title: "How it works — Architecture, EVM X-Ray, AMM math & EIP-5792 rescue",
  description: "How Kestrel reads Base and Robinhood Chain over raw RPC: opcode-level bytecode inspection, EIP-1967 storage slots, constant-product and Uniswap v3 stress math, LayerZero OFT parity, Vibestarter tranche escrows and EIP-5792 atomic rescue.",
  alternates: { canonical: "/how-it-works" },
  openGraph: { title: "How Kestrel works — raw RPC, EVM X-Ray, AMM math, EIP-5792 rescue", description: "Opcode-level bytecode inspection, EIP-1967 slots, BigInt AMM stress math, LayerZero OFT parity, Vibestarter escrows and atomic rescue on Base & Robinhood Chain." },
};

// The READ and parity sidenotes carry live block heights; the ribbon read is memoised for 15 s server-side.
export const revalidate = 60;

const TOC = [
  { id: "why-now", label: "Why now" },
  { id: "read", label: "Read" },
  { id: "score", label: "Score" },
  { id: "simulate", label: "Simulate" },
  { id: "rescue", label: "Rescue" },
  { id: "page", label: "Page" },
  { id: "architecture", label: "Architecture" },
  { id: "xray", label: "EIP-1967 X-Ray" },
  { id: "amm", label: "AMM math" },
  { id: "parity", label: "OFT parity" },
  { id: "deltas", label: "Overnight deltas" },
  { id: "shield", label: "Backer Shield" },
  { id: "eip5792", label: "EIP-5792 rescue" },
];

const PARITY_LABEL: Record<string, string> = { VERIFIED: "EXACT", IN_FLIGHT: "IN FLIGHT", OVER_BACKED: "OVER BACKED", BACKED: "BACKED", DRIFT: "UNBACKED", UNKNOWN: "UNREAD" };

const fmtBlock = (b: string) => `#${BigInt(b).toLocaleString("en-US")}`;

/** Live sidenote: both chain heads as read by the server for this page render. */
async function HeadsNote() {
  const t = await getRibbonTelemetryCached().catch(() => null);
  if (!t) return <p>Head reads unavailable for this render. Nothing is shown in their place.</p>;
  return (
    <>
      <p className="t-kicker">Read for this page</p>
      <ul className="mt-3 space-y-2">
        <li className="flex items-center gap-2">
          <Led tone="base" />
          <span>BASE</span>
          {t.baseBlock ? (
            <a href={explorerBlock(8453, t.baseBlock)} target="_blank" rel="noreferrer" className="tnum text-ink hover:text-phosphor">
              {fmtBlock(t.baseBlock)} <span className="text-ink-3">↗</span>
            </a>
          ) : (
            <span>unavailable</span>
          )}
        </li>
        <li className="flex items-center gap-2">
          <Led tone="rh" />
          <span>RH</span>
          {t.rhBlock ? (
            <a href={explorerBlock(4663, t.rhBlock)} target="_blank" rel="noreferrer" className="tnum text-ink hover:text-phosphor">
              {fmtBlock(t.rhBlock)} <span className="text-ink-3">↗</span>
            </a>
          ) : (
            <span>unavailable</span>
          )}
        </li>
      </ul>
      <p className="mt-3">at {t.fetchedAt.slice(11, 19)} UTC</p>
    </>
  );
}

/** Live sidenote: the current $VIBES OFT 1:1 status. */
async function ParityNote() {
  const t = await getRibbonTelemetryCached().catch(() => null);
  const status = t?.parity ?? "UNKNOWN";
  const tone = status === "DRIFT" ? "crit" : status === "UNKNOWN" ? "idle" : "phosphor";
  return (
    <>
      <p className="t-kicker">$VIBES OFT 1:1 now</p>
      <p className={`mt-3 flex items-center gap-2 text-[15px] ${status === "DRIFT" ? "text-crit" : status === "UNKNOWN" ? "text-ink-meta" : "text-phosphor"}`}>
        <Led tone={tone} />
        {PARITY_LABEL[status]}
      </p>
      {t && <p className="mt-2">at {t.fetchedAt.slice(11, 19)} UTC</p>}
      <p className="mt-3">
        <InkLink href="/app?tab=parity" className="text-[13px]">
          Open the parity desk
        </InkLink>
      </p>
    </>
  );
}

export default function HowItWorks() {
  return (
    <article className="min-w-0">
      <PageMasthead
        kicker="How it works"
        title={["An overnight desk that", "reads the chain itself."]}
        dek="No indexer, no cached price database, no mock data. Every figure is read from Base and Robinhood Chain at request time, with its block number and an explorer link."
        meta={
          <>
            <span>Base 8453</span>
            <span className="text-ink-3">·</span>
            <span>Robinhood Chain 4663</span>
            <span className="text-ink-3">·</span>
            <span>READ → SCORE → SIMULATE → RESCUE → PAGE</span>
          </>
        }
      />

      <DocGrid toc={TOC}>
        <Chapter id="why-now" kicker="The problem" title={["Why Base and Robinhood Chain need overnight defense now"]}>
          <p>
            Onchain risk does not keep office hours. Three things go wrong while you sleep, and all three are now live on the two chains Kestrel watches.
          </p>
          <H3>03:42 UTC: an approval you forgot gets drained</H3>
          <p>
            Unlimited ERC-20 and Permit2 allowances outlive the dApps you granted them to. When one of those spenders is compromised, revoking eight approvals one wallet
            popup at a time, at 3am and mid-exploit, fails halfway. The attacker needs one block; you need eight signatures.
          </p>
          <H3>Two chains: bridged supply can quietly lose its backing</H3>
          <p>
            Base and Robinhood Chain are linked by a LayerZero OFT for <C>$VIBES</C>. The same asset trades in two pools on two chains, and the two supplies must reconcile to
            the wei. If circulating supply on Robinhood ever exceeds what is locked on Base, someone minted unbacked tokens. Nobody checks that invariant block by block, so
            Kestrel does.
          </p>
          <H3>72 hours: backers miss the only window that matters</H3>
          <p>
            On Vibestarter, founders unlock each 15% tranche publicly and backers have exactly 72 hours to challenge it. That window routinely opens while half the
            community is asleep. Most backers find out after the money has moved.
          </p>
        </Chapter>

        <Chapter
          id="read"
          kicker="Read"
          tone="phosphor"
          title={["Every number comes off the wire."]}
          side={
            <Suspense fallback={<p className="cursor-blink">Reading both chain heads</p>}>
              <HeadsNote />
            </Suspense>
          }
        >
          <p>
            Kestrel reads <C>eth_getCode</C>, EIP-1967 storage slots, <C>getReserves</C> and <C>slot0</C>, ERC-20 and Permit2 allowances, and Transfer and Approval logs straight
            from public Base and Robinhood Chain RPCs. Vibestarter campaign metadata comes from its public API and MCP server. Nothing is pre-indexed and nothing is
            interpolated: if a read fails, the cell says so.
          </p>
          <p>
            Robinhood Chain&apos;s Cloudflare WAF rejects default bot user agents, so server-side clients send a named <C>Kestrel-Sentinel/1.0</C> agent. Base reads fall back
            from <C>mainnet.base.org</C> to a second public endpoint, and both chains batch through Multicall3.
          </p>
        </Chapter>

        <Chapter
          id="score"
          kicker="Score"
          tone="phosphor"
          title={["Findings that add up to a score."]}
          side={
            <>
              <p className="t-kicker">Bands</p>
              <ul className="mt-3 space-y-1.5">
                <li className="flex justify-between gap-3"><span className="text-phosphor">NOMINAL</span><span className="tnum">0–29</span></li>
                <li className="flex justify-between gap-3"><span className="text-warn">ELEVATED</span><span className="tnum">30–64</span></li>
                <li className="flex justify-between gap-3"><span className="text-crit">CRITICAL</span><span className="tnum">65–100</span></li>
              </ul>
            </>
          }
        >
          <p>
            Deterministic, documented rules turn findings into a 0–100 Overnight Threat score. Every finding carries explicit points: a mutable proxy with an EOA admin is +25,
            a single-key owner of a contract with privileged selectors +18, each unlimited approval +10, LP depth down 15% overnight +15, an open challenge window +15, an
            unbacked bridge +30.
          </p>
          <p>The score is their clamped sum, so every point on screen traces back to a block and a link. If no language model is configured, the Morning Desk Brief is written by rules from the same findings.</p>
        </Chapter>

        <Chapter id="simulate" kicker="Simulate" tone="phosphor" title={["Stress the exit before it happens."]}>
          <p>
            The Rug Lab replays the night&apos;s worst cases against live pool state: the top whale dumps 100%, half the liquidity is pulled, the OFT bridge rate limit
            saturates. All arithmetic is BigInt, from Aerodrome reserves and Uniswap v3 <C>sqrtPriceX96</C> and <C>liquidity</C>. The formulas are in{" "}
            <InkLink href="#amm">AMM math</InkLink> below.
          </p>
        </Chapter>

        <Chapter id="rescue" kicker="Rescue" tone="phosphor" title={["One signature, simulated first."]}>
          <p>
            The Panic Bunker batches every revoke and an optional unwind to USDC into one EIP-5792 <C>wallet_sendCalls</C> bundle on smart wallets, and steps EOAs through the
            same calls one by one. Every call is simulated before the wallet is asked to sign. The procedure is in <InkLink href="#eip5792">EIP-5792 rescue</InkLink>.
          </p>
        </Chapter>

        <Chapter id="page" kicker="Page" tone="phosphor" title={["A pager that opens the bunker."]}>
          <p>
            Night-Shift Pager watches fire on thresholds you set: LP down more than 15%, cross-chain spread above 3%, a 72-hour challenge window opening. Each alert goes to a
            webhook or Telegram with a deep link such as <C>/rescue?target=0x…&amp;chain=8453</C>, which opens the Panic Bunker already loaded with the target. Try it on a live
            Safe: <InkLink href="/rescue?target=0x05CEa6C36f3a44944A4F4bA39B1820677AcB97EE&chain=8453">the Send treasury rescue preview</InkLink>.
          </p>
        </Chapter>

        <Chapter
          id="architecture"
          kicker="Mechanics"
          title={["Architecture"]}
          wide={
            <Plate label={<><span>stack</span><span>server: viem · browser: wagmi</span></>}>{`Next.js 15 App Router (SSR: / · /app · /how-it-works · /agents · /ecosystem · /rescue)
│
├── Onchain engine (viem, server-side)
│   ├── Base client      mainnet.base.org → publicnode fallback · multicall batching
│   ├── Robinhood client rpc.mainnet.chain.robinhood.com (+ clean User-Agent for WAF) · Multicall3
│   ├── xray.ts     eth_getCode opcode walk · EIP-1967 slots · owner()/Safe posture
│   ├── pools.ts    Aerodrome getReserves / Uni v3 slot0+liquidity · 8h deltas
│   ├── wallet.ts   ERC-20 allowance() · Permit2 allowance() · Approval logs (8h)
│   ├── flow.ts     Transfer logs (8h) → volume, largest transfer, top active holder
│   ├── parity.ts   OFT 1:1 invariant · cross-venue spread · gas drag
│   ├── escrow.ts   VibesTranchEscrow (uint8 tranche ABI) + Vibestarter API enrichment
│   └── findings.ts deterministic scoring → 0–100 · NOMINAL / ELEVATED / CRITICAL
│
├── Agent & alert surfaces
│   ├── /api/v1/guard     ALLOW | WARN | BLOCK · x402 v2 + v1 (EIP-3009 USDC on Base, settled before the verdict)
│   ├── /api/x402/revenue onchain ledger of every x402 payment received
│   ├── /api/mcp          Streamable HTTP MCP · 11 tools (8 read-only + 3 pager)
│   ├── /api/pager/*      watches · webhook / Telegram with /rescue deep links
│   └── /api/brief        0G Compute → Anthropic → deterministic brief
│
└── Non-custodial execution (browser, wagmi)
    ├── wallet_getCapabilities → atomic? → wallet_sendCalls (EIP-5792)
    └── fallback: sequential writeContract · every call simulateContract'd first`}</Plate>
          }
        >
          <p>One server-side engine reads both chains; the browser only ever signs. The same engine backs the web desk, the agent gate, the MCP server and the pager.</p>
        </Chapter>

        <Chapter id="xray" kicker="Mechanics" title={["Bytecode and EIP-1967 X-Ray"]}>
          <p>
            Kestrel fetches runtime bytecode with <C>eth_getCode</C> and walks it opcode by opcode, skipping PUSH immediates and the trailing Solidity CBOR metadata. A selector
            is flagged only when it appears as a genuine <C>PUSH4</C> operand in the dispatcher, and <C>SELFDESTRUCT</C> / <C>DELEGATECALL</C> only when they are real opcodes,
            not bytes inside push data. Selectors are derived with keccak256 from canonical signatures at runtime: mint, burn, pause, blacklist variants, setTax and setFees,
            setMaxTxAmount, upgradeTo, upgradeToAndCall.
          </p>
          <p>
            It then reads the EIP-1967 implementation (<C>0x3608…2bbc</C>), admin (<C>0xb531…6103</C>) and beacon slots with <C>eth_getStorageAt</C>, plus the legacy
            ZeppelinOS slots that Base USDC still uses. If a proxy is found, the implementation&apos;s code is the code analyzed. EIP-1167 minimal clones resolve to their logic
            contract, and EIP-7702 delegated EOAs (<C>0xef0100‖address</C>) are recognised. Finally <C>owner()</C>, <C>admin()</C> and the admin slot are classified: renounced,
            single EOA, Safe (<C>getThreshold()</C> / <C>getOwners()</C> as m-of-n) or other contract.
          </p>
        </Chapter>

        <Chapter
          id="amm"
          kicker="Mechanics"
          title={["Simulate the Rug: AMM math in BigInt"]}
          wide={
            <Plate lines label={<><span>constant product · concentrated liquidity</span><span>BigInt only</span></>}>{`Constant product (Aerodrome volatile, live fee from PoolFactory.getFee):
  out = (in · (10000 − feeBps) · R_out) / (R_in · 10000 + in · (10000 − feeBps))

Shock order:
  1. LP pull:     R_x ← R_x · (1 − pull),  R_y ← R_y · (1 − pull)
  2. Whale sells: R_weth −= quote(whaleAmt);  R_token += whaleAmt
  3. You exit:    out_after = quote(position)
  drawdown = (out_before − out_after) / out_before

Uniswap v3 (Robinhood Chain), from live slot0().sqrtPriceX96 and liquidity():
  x_virtual = L · 2^96 / √P        y_virtual = L · √P / 2^96
  exact within the active liquidity range (no tick crossings)`}</Plate>
          }
        >
          <p>No reserve, sqrtPrice or allowance is ever cast to a JavaScript Number before decimal scaling.</p>
          <p>
            The &ldquo;Top whale dumps 100%&rdquo; scenario uses a real wallet: the largest current holder among addresses active in the token&apos;s Transfer logs over the last
            8 hours, excluding pools, bridge adapters and escrows.
          </p>
        </Chapter>

        <Chapter
          id="parity"
          kicker="Mechanics"
          title={["Base and Robinhood parity"]}
          side={
            <Suspense fallback={<p className="cursor-blink">Reading parity</p>}>
              <ParityNote />
            </Suspense>
          }
          wide={<Plate label={<><span>1:1 proof-of-reserve invariant</span><span>both chains at latest block</span></>}>{`VIBES_base.balanceOf(BaseAdapter) == VIBES_rh.totalSupply() − VIBES_rh.balanceOf(RHReserveAdapter)`}</Plate>}
        >
          <p>
            <C>$VIBES</C> is canonical on Base (1B fixed supply). Bridging to Robinhood Chain locks tokens in the Base OFT adapter{" "}
            <AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} /> and releases them from the Robinhood reserve adapter{" "}
            <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} />. Kestrel reads both chains at their latest blocks and reports a signed verdict: EXACT
            when locked equals circulating, IN FLIGHT or OVER BACKED when holders are covered, UNBACKED only when circulating exceeds locked on two fresh reads.
          </p>
          <p>
            It then compares VIBES per WETH on the Base Aerodrome pool <AddrLink chainId={8453} address={CONTRACTS.base.vibesAerodromePool} /> and the Robinhood Uniswap v3 1%
            pool <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesUniswapV3Pool} />, reports the spread in basis points, and subtracts both pool fees and live gas.
          </p>
          <p>
            The OFT rate limit is an inbound credit budget enforced on delivery, not on send. On 2026-09-05 four Base to Robinhood packets hit <C>RateLimitExceeded</C> at
            10M per hour and were delivered between 4 minutes and 3.6 hours late, which is why the Rug Lab models a saturated bridge.
          </p>
        </Chapter>

        <Chapter id="deltas" kicker="Mechanics" title={["Overnight deltas"]}>
          <p>
            &ldquo;While you slept&rdquo; means the last 8 hours, resolved to a block height from each chain&apos;s block timestamps. On Base, Kestrel re-reads pool state at that
            historical block. Robinhood Chain&apos;s public RPC prunes historical state after roughly ten thousand blocks, so there Kestrel reconstructs the night from retained
            Swap, Mint and Burn event logs instead, and says so in the UI.
          </p>
        </Chapter>

        <Chapter id="shield" kicker="Mechanics" title={["Vibestarter Backer Shield"]}>
          <p>
            Kestrel enumerates escrows from <C>VibesTranchEscrowFactory.getAllEscrows()</C> (<AddrLink chainId={8453} address={CONTRACTS.base.vibesTranchEscrowFactory} />), the
            Genesis escrow and every campaign in Vibestarter&apos;s public API on both chains. For each clone it reads <C>getCampaign()</C>, <C>getActiveChallenge()</C>, the
            escrow&apos;s own oracle time and, per tranche, <C>trancheClaimed</C>, <C>trancheRequestedAt</C>, <C>trancheChallenged</C>, <C>getTrancheAmount</C> and{" "}
            <C>getTrancheUnlockTime</C>, all with the deployed <C>uint8</C> signatures. A tranche requested less than <C>CHALLENGE_WINDOW</C> (72h) ago gets a live countdown.
            The same reads power the <InkLink href="/ecosystem">ecosystem board</InkLink>.
          </p>
        </Chapter>

        <Chapter
          id="eip5792"
          kicker="Mechanics"
          title={["EIP-5792 atomic rescue"]}
          wide={
            <Procedure
              steps={[
                { title: "Build the bundle", body: <>ERC-20 <C>approve(spender, 0)</C> revokes, one <C>Permit2.lockdown()</C> for every Permit2 sub-allowance, and optional unwinds through the Aerodrome router to USDC with a live <C>getAmountsOut</C> quote and 3% maximum slippage.</> },
                { title: "Simulate every call", body: <>Each call runs through <C>publicClient.simulateContract</C>. Swaps that depend on an approve in the same bundle are verified with sequential <C>eth_simulateV1</C>. Signing stays disabled until every call passes, and reverts are decoded into plain English.</> },
                { title: "Ask the wallet what it can do", body: <><C>wallet_getCapabilities</C> reports whether the connected wallet (Coinbase Smart Wallet, Safe, Ambire) supports atomic batches.</> },
                { title: "Sign once, or step through", body: <>Atomic wallets receive one <C>wallet_sendCalls</C> bundle and one signature. EOAs such as MetaMask and Rabby step through the same calls with live Basescan links. Kestrel never requests or stores private keys.</> },
              ]}
            />
          }
        >
          <p>
            At 3am mid-exploit, signing eight separate approval popups fails halfway. The Panic Bunker turns the whole rescue into one procedure.
          </p>
        </Chapter>

        <DocActions>
          <Link href="/app" className="btn-primary press">
            LAUNCH APP
          </Link>
          <Link href="/agents" className="btn-ghost press">
            Agent API
          </Link>
        </DocActions>
      </DocGrid>
    </article>
  );
}
