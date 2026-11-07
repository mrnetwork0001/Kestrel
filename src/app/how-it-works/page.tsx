import type { Metadata } from "next";
import Link from "next/link";
import { CONTRACTS } from "@/config/contracts";
import { AddrLink, Panel, SectionLabel } from "@/components/ui";

export const metadata: Metadata = {
  title: "How it works — Architecture, EVM X-Ray, AMM math & EIP-5792 rescue",
  description: "How Kestrel reads Base and Robinhood Chain over raw RPC: opcode-level bytecode inspection, EIP-1967 storage slots, constant-product and Uniswap v3 stress math, LayerZero OFT parity, Vibestarter tranche escrows and EIP-5792 atomic rescue.",
};

function H2({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="mt-20">
      <SectionLabel n={n}>{String(children)}</SectionLabel>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="mt-4 overflow-x-auto border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2">{children}</pre>;
}

export default function HowItWorks() {
  return (
    <article className="mx-auto max-w-[960px] px-4 pb-10 pt-12">
      <SectionLabel n="00">How it works</SectionLabel>
      <h1 className="mt-4 font-serif text-[48px] leading-[1.04] text-ink">An overnight desk that reads the chain itself.</h1>
      <p className="mt-5 text-[15px] leading-relaxed text-ink-2">
        Kestrel has no indexer, no database of cached prices and no mock data. Every number is read from Base Mainnet (8453) and Robinhood Chain Mainnet (4663) over
        public JSON-RPC at request time, or from Vibestarter&apos;s public campaigns API, and is shown with its block number and an explorer link.
      </p>

      <H2 n="01">The problem</H2>
      <div className="mt-4 space-y-4 text-[14px] leading-relaxed text-ink-2">
        <p>
          Onchain risk does not keep office hours. Approvals granted months ago stay live. LP can be pulled in one block. A bridged token can lose its backing if
          the lock-and-mint invariant breaks. On Vibestarter, founders unlock each 15% tranche publicly and backers have exactly 72 hours to challenge — a window
          that routinely opens while half the community is asleep.
        </p>
        <p>
          Base and Robinhood Chain are now linked by a LayerZero OFT for <span className="mono text-ink">$VIBES</span>, which makes the problem cross-venue:
          the same asset trades in two pools on two chains, and the two supplies must reconcile to the wei. Nobody watches that invariant block by block —
          so Kestrel does.
        </p>
      </div>

      <H2 n="02">Architecture</H2>
      <Code>{`Next.js 15 App Router (SSR pages: / · /app · /how-it-works · /token · /agents · /rescue)
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
│   ├── /api/v1/guard   ALLOW | WARN | BLOCK · x402 (EIP-3009 USDC on Base)
│   ├── /api/mcp        Streamable HTTP MCP · 4 tools
│   ├── /api/pager/test webhook / Telegram with /rescue deep links
│   └── /api/brief      0G Compute → Anthropic → deterministic brief
│
└── Non-custodial execution (browser, wagmi)
    ├── wallet_getCapabilities → atomic? → wallet_sendCalls (EIP-5792)
    └── fallback: sequential writeContract · every call simulateContract'd first`}</Code>

      <H2 n="03">Bytecode & EIP-1967 X-Ray</H2>
      <div className="mt-4 space-y-4 text-[14px] leading-relaxed text-ink-2">
        <p>
          Kestrel fetches runtime bytecode with <span className="mono text-ink">eth_getCode</span> and walks it opcode by opcode, skipping PUSH immediates and the trailing
          Solidity CBOR metadata. A selector is flagged only when it appears as a genuine <span className="mono text-ink">PUSH4</span> operand — the dispatcher pattern —
          and <span className="mono text-ink">SELFDESTRUCT</span> / <span className="mono text-ink">DELEGATECALL</span> only when they are real opcodes, not bytes inside push data.
          Selectors are derived with keccak256 from canonical signatures at runtime (mint, burn(address,uint256), pause, blacklist variants, setTax/setFees, setMaxTxAmount, upgradeTo, upgradeToAndCall).
        </p>
        <p>
          It then reads the EIP-1967 implementation (<span className="mono text-ink">0x3608…2bbc</span>), admin (<span className="mono text-ink">0xb531…6103</span>) and beacon slots with{" "}
          <span className="mono text-ink">eth_getStorageAt</span>. If a proxy is found, the implementation&apos;s code is the code analyzed. EIP-1167 minimal clones are resolved to their logic
          contract, and EIP-7702 delegated EOAs (<span className="mono text-ink">0xef0100‖address</span>) are recognized. Finally <span className="mono text-ink">owner()</span>,{" "}
          <span className="mono text-ink">admin()</span> and the admin slot are classified: renounced, single EOA, Safe (<span className="mono text-ink">getThreshold()</span> /{" "}
          <span className="mono text-ink">getOwners()</span> → m-of-n), or other contract.
        </p>
      </div>

      <H2 n="04">Simulate the Rug — AMM math</H2>
      <div className="mt-4 space-y-4 text-[14px] leading-relaxed text-ink-2">
        <p>All arithmetic is BigInt. No reserve, sqrtPrice or allowance is ever cast to a JavaScript Number before decimal scaling.</p>
        <Code>{`Constant product (Aerodrome volatile, live fee from PoolFactory.getFee):
  out = (in · (10000 − feeBps) · R_out) / (R_in · 10000 + in · (10000 − feeBps))

Shock order:
  1. LP pull:     R_x ← R_x · (1 − pull),  R_y ← R_y · (1 − pull)
  2. Whale sells: R_weth −= quote(whaleAmt);  R_token += whaleAmt
  3. You exit:    out_after = quote(position)
  drawdown = (out_before − out_after) / out_before

Uniswap v3 (Robinhood Chain), from live slot0().sqrtPriceX96 and liquidity():
  x_virtual = L · 2^96 / √P        y_virtual = L · √P / 2^96
  → exact within the active liquidity range (no tick crossings)`}</Code>
        <p>
          The &ldquo;Top whale dumps 100%&rdquo; scenario uses a real wallet: the largest current holder among addresses active in the token&apos;s Transfer logs over the last 8 hours,
          excluding pools, bridge adapters and escrows.
        </p>
      </div>

      <H2 n="05">Base ↔ Robinhood parity</H2>
      <div className="mt-4 space-y-4 text-[14px] leading-relaxed text-ink-2">
        <p>
          <span className="mono text-ink">$VIBES</span> is canonical on Base (1B fixed supply). Bridging to Robinhood Chain locks tokens in the Base OFT adapter{" "}
          <AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} /> and releases them from the Robinhood reserve adapter{" "}
          <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} />. Kestrel reads both chains at their latest blocks and checks:
        </p>
        <Code>{`VIBES_base.balanceOf(BaseAdapter) == VIBES_rh.totalSupply() − VIBES_rh.balanceOf(RHReserveAdapter)`}</Code>
        <p>
          It then compares VIBES per WETH on the Base Aerodrome pool <AddrLink chainId={8453} address={CONTRACTS.base.vibesAerodromePool} /> and the Robinhood Uniswap v3 1% pool{" "}
          <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesUniswapV3Pool} />, reports the spread in basis points, subtracts both pool fees, and shows live gas on both chains.
        </p>
      </div>

      <H2 n="06">Overnight deltas</H2>
      <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
        &ldquo;While you slept&rdquo; means the last 8 hours, resolved to a block height from each chain&apos;s live average block time. On Base, Kestrel re-reads pool state at that
        historical block. Robinhood Chain&apos;s public RPC prunes historical state after roughly ten thousand blocks, so there Kestrel reconstructs the night from retained
        Swap / Mint / Burn event logs instead — and says so in the UI.
      </p>

      <H2 n="07">Vibestarter Backer Shield</H2>
      <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
        Kestrel enumerates escrows from <span className="mono text-ink">VibesTranchEscrowFactory.getAllEscrows()</span>{" "}
        (<AddrLink chainId={8453} address={CONTRACTS.base.vibesTranchEscrowFactory} />), the Genesis escrow, and every campaign in Vibestarter&apos;s public API on both chains. For each
        clone it reads <span className="mono text-ink">getCampaign()</span>, <span className="mono text-ink">getActiveChallenge()</span>, the escrow&apos;s own oracle time and, per tranche,{" "}
        <span className="mono text-ink">trancheClaimed / trancheRequestedAt / trancheChallenged / getTrancheAmount / getTrancheUnlockTime</span> — all with the deployed{" "}
        <span className="mono text-ink">uint8</span> signatures. A tranche requested less than <span className="mono text-ink">CHALLENGE_WINDOW</span> (72h) ago gets a live countdown.
      </p>

      <H2 n="08">EIP-5792 atomic rescue</H2>
      <div className="mt-4 space-y-4 text-[14px] leading-relaxed text-ink-2">
        <p>
          At 3am mid-exploit, signing eight separate <span className="mono text-ink">approve(spender, 0)</span> popups fails halfway. The Panic Bunker builds the whole rescue as one
          bundle: ERC-20 revokes, a single <span className="mono text-ink">Permit2.lockdown()</span> for every Permit2 sub-allowance, and optional unwinds through the Aerodrome router
          to USDC with a live <span className="mono text-ink">getAmountsOut</span> quote and 3% max slippage.
        </p>
        <p>
          Each call is run through <span className="mono text-ink">publicClient.simulateContract</span>; swaps that depend on an approve in the same bundle are verified with sequential{" "}
          <span className="mono text-ink">eth_simulateV1</span>. Signing is disabled until every call passes. If <span className="mono text-ink">wallet_getCapabilities</span> reports atomic
          support, the bundle is sent with <span className="mono text-ink">wallet_sendCalls</span> — one signature. Otherwise the user steps through a sequential flow with live Basescan links.
          Kestrel never requests or stores private keys.
        </p>
      </div>

      <H2 n="09">Scoring</H2>
      <p className="mt-4 text-[14px] leading-relaxed text-ink-2">
        Every finding carries explicit points (for example: mutable proxy with an EOA admin +25, single-key owner of a contract with privileged selectors +18, unlimited approval +10 each,
        LP depth −15% overnight +15, open challenge window +15, parity drift +30). The score is their clamped sum, so every point on screen traces back to a block and a link.
      </p>

      <div className="mt-16 flex flex-wrap gap-4">
        <Link href="/app" className="rounded-[2px] bg-phosphor px-5 py-3 mono text-[13px] font-semibold text-canvas hover:bg-[#a6e698]">LAUNCH APP →</Link>
        <Link href="/agents" className="rounded-[2px] border border-hair-strong px-5 py-3 mono text-[13px] text-ink hover:border-phosphor/60">Agent API</Link>
      </div>
    </article>
  );
}
