# CLAUDE.md — Kestrel (`$KEST`)

> **Competition:** Vibestarter **Vibeathon 02: Night Shift**
> **Hard Submission Deadline:** Monday, November 9, 2026 at **22:00 UTC**
> **App Name:** **Kestrel** (`$KEST`)
> **One-Line Pitch:** *Autonomous overnight risk, liquidity, bridge parity, and tranche-escrow sentinel for Base & Robinhood Chain.*
> **Tagline:** *"Stay asleep. Kestrel watches the chain."*

---

## 1. Mission & Why Kestrel Wins Vibeathon 02

Kestrel is built to win **both** the Vibeathon 02 Judge Panel (Human builders + Claude + GPT) **and** the `$VIBES` Holder Community Vote (weighted by `$VIBES` staked/held on Base), while scoring **`FUNDABLE`** on [fundable.vibestarter.xyz](https://fundable.vibestarter.xyz).

### Scoring Alignment (Never Lose Sight of the Rubric)
1. **Execution (30%):** 100% real, live RPC reads on **Base Mainnet (`8453`)** and **Robinhood Chain Mainnet (`4663`)** + real wallet write actions. **ZERO fake mock JSON. ZERO hardcoded dummy prices.** Every visitor can inspect real wallets, tokens, DEX pools, OFT bridges, and Vibestarter escrows in **under 5 seconds with zero wallet-connect gate**.
2. **Launch Potential (25%) & `$VIBES` Holder Vote:** Clear Business-to-Agent (`x402` USDC pay-per-scan on Base + MCP) and Business-to-Trader SaaS/token utility (`$KEST` staking for sub-block overnight watcher slots, automated Panic Bunker policies, and fee rebates). Native `$VIBES` cross-chain parity + Vibestarter Escrow Backer Shield turns every `$VIBES` voter into an immediate user.
3. **Originality (20%):** Does NOT clone Wave 1 projects (*Corvo Edge* chat trading terminal, *Onetoken* launchpad, *playMAYHEM* arcade, *Loyal Spark* loyalty). Owns the untouched **Overnight Defensive Sentinel + Base ↔ Robinhood Chain Cross-Venue Risk** category.
4. **Craft & UX (15%):** "10-Storey Night Shift Tower" dark terminal aesthetic (`#07090D` obsidian, `#91D982` phosphor terminal green `>_`, Base blue `#38BDF8`, Robinhood neon `#C8FF00`, crisp tabular monospace numerals).
5. **Vibecoding Leverage (10%):** Built end-to-end with Claude Code, exposes `/llms.txt`, `/api/openapi.json`, and an HTTP MCP endpoint (`/api/mcp`), and consumes Vibestarter's own MCP (`https://app.vibestarter.xyz/mcp`).

---

## 2. All 8 Core Product Pillars (Required Scope)

1. **"While You Slept" 8-Hour Night Shift Briefing (Zero-Auth Landing Experience)**
   - Input *any* Base or Robinhood Chain wallet, token, pool, or escrow address (plus 1-click live Mainnet presets on the hero screen).
   - Generates a live **Overnight Threat & Health Score (`0–100`: `NOMINAL` / `ELEVATED` / `CRITICAL`)**, scanning open `ERC-20` + `Permit2` approvals, LP depth changes, whale concentration, and an AI-synthesized plain-English **Morning Desk Brief**.

2. **1-Click Atomic "Panic Bunker" (`EIP-5792` `wallet_sendCalls` Batch Rescue)**
   - Builds an atomic rescue bundle on Base using **EIP-5792 (`wallet_sendCalls`)** for Smart Wallets (Coinbase Smart Wallet, Safe, Ambire) to **revoke all risky `ERC-20`/`Permit2` approvals + unwind/swap exposed tokens to USDC in ONE single signature**.
   - Automatically detects wallet capabilities (`wallet_getCapabilities`) and falls back gracefully to guided sequential `writeContract` signing for standard EOAs (MetaMask/Rabby).
   - Always run `publicClient.simulateContract` before prompting any signature.

3. **Interactive "Simulate the Rug" Chaos Stress-Tester (Live AMM Math)**
   - Interactive stress buttons/sliders on any scanned token or portfolio:
     - *"Top Whale Dumps 100%"*
     - *"50% Liquidity Pulled"*
     - *"OFT Bridge Rate-Limit Saturated"*
   - Computes exact constant-product (`x * y = k` / Aerodrome `getReserves`) and concentrated-liquidity (`slot0` `sqrtPriceX96` + `liquidity` on Uniswap v3) price impact, slippage %, and surviving USD/ETH exit value in real time using `BigInt` math.

4. **Live Base ↔ Robinhood Chain Bridge Parity & Spread Radar**
   - Live dual-RPC verification of LayerZero OFT bridged assets—headlined by `$VIBES`:
     - **1:1 Proof-of-Reserve Invariant:** Verifies `BaseAdapter.balanceOf(VIBES_BASE) === RobinhoodVIBES.totalSupply() - RobinhoodReserveAdapter.balanceOf(VIBES_RH)`.
     - **Pool Price Dislocation %:** Compares live `$VIBES / WETH` spot price on **Base Aerodrome (`0x07F78058685b75F89288f025a0a154A96021Ac45`)** vs **Robinhood Chain Uniswap v3 (`0x3A9BFEc8ae16Bf023C3119C38A04Fb054A19bAc5`)** and flags net arbitrage/spread opportunities after gas + bridge fees.

5. **Vibestarter "Backer Shield" (Tranche & 72h Challenge Watchdog)**
   - Reads Vibestarter's live `VibesTranchEscrowFactory` (`0x36C7e2d87F4E2d33b70304EbaA81eE88CB04Bf86`), per-raise `VibesTranchEscrow` clones (including the live Genesis `$VIBES` Escrow `0x0e9bf34baed84a80d7647dafe4db52169147c911`), `VibesRegistry` Origin Capsules, and `/api/campaigns`.
   - Tracks the 10% kickstart + six 15% monthly tranches, **live 72-hour challenge window countdowns**, permanent LP lock status, founder GitHub velocity, and live app HTTP health—giving `$VIBES` backers an independent safety radar before a challenge window closes.

6. **Raw EVM Bytecode & EIP-1967 Storage-Slot X-Ray**
   - Pure RPC inspection (`eth_getCode` + `eth_getStorageAt` at EIP-1967 implementation `0x3608...bbc` and admin `0xb531...103` slots) on both Base and Robinhood Chain.
   - Detects unverified contracts, mutable proxy implementations, EOA admin keys vs multisigs (`getOwners()`/`getThreshold()`), and risky 4-byte selectors (`pause()`, `blacklist(address)`, `mint(address,uint256)`, `setTax()`, `selfdestruct`).

7. **Pre-Trade Security Gate for AI Agents (`x402` USDC on Base + MCP + `/llms.txt`)**
   - `GET/POST /api/v1/guard`: Machine-readable contract & pool safety verdict (`ALLOW | WARN | BLOCK`, risk score, reasons, simulated slippage). Supports free preview tier + **HTTP `402 Payment Required` (`x402` Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)** verification for autonomous trading agents, plus an interactive **"Simulate Agent x402 Call"** playground in the UI.
   - `/api/mcp`: Streamable HTTP Model Context Protocol server exposing `scan_contract`, `check_bridge_parity`, `simulate_exit`, and `inspect_vibestarter_escrow`.

8. **Night-Shift Pager (Telegram / Webhook Alert Rules + Rescue Deep-Links)**
   - Let users configure live watch thresholds (e.g., *"Alert if LP drops > 15%, cross-chain spread > 3%, or a 72h escrow challenge window opens"*) with an instant **"Send Live Test Pager"** webhook/Telegram dispatch containing a 1-click deep link (`/rescue?target=0x...&chain=8453`) straight into Kestrel's Atomic Panic Bunker.

---

## 3. Live-Verified Chains, RPCs & Contract Addresses (DO NOT GUESS)

All addresses in `src/config/chains.ts` and `src/config/contracts.ts` were verified live against Mainnet RPCs on 2026-11-04:

### Networks
| Network | Chain ID | Public RPC | Block Explorer |
| :--- | :--- | :--- | :--- |
| **Base Mainnet** | `8453` (`0x2105`) | `https://mainnet.base.org` (fallback: `https://base-rpc.publicnode.com`) | `https://basescan.org` |
| **Robinhood Chain Mainnet** | `4663` (`0x1237`) | `https://rpc.mainnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` |

> **CRITICAL ROBINHOOD CHAIN RPC GOTCHA:**
> Robinhood Chain's Cloudflare WAF returns `HTTP 403` if a server-side client sends default Python/bot User-Agents. In `viem` server-side `http()` transports for Chain `4663`, **always** pass `fetchOptions: { headers: { 'User-Agent': 'Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)' } }`.

### Verified Mainnet Contracts
- **Base `$VIBES` Token (Canonical, 1B fixed supply):** `0xefFC8815487084a97edfdfF968b56Ea123421Acb`
- **Robinhood Chain `$VIBES` Token:** `0x9A73D60b9c8C2d330EB6D885E69fCc1399c33C18`
- **Base OFT Bridge Adapter (holds locked `$VIBES`):** `0x408021Cb4ef1033675C70CF97788F3E03f45A381`
- **Robinhood Chain OFT Reserve Adapter (holds unbridged reserve):** `0x37F26e3025b3DC50e0EE9f610D386803B42D0685`
- **Base Aerodrome `WETH / VIBES` Pool:** `0x07F78058685b75F89288f025a0a154A96021Ac45`
  - `token0`: Base `WETH` (`0x4200000000000000000000000000000000000006`)
  - `token1`: Base `VIBES` (`0xefFC8815487084a97edfdfF968b56Ea123421Acb`)
- **Robinhood Chain Uniswap v3 `WETH / VIBES` Pool (1% fee tier):** `0x3A9BFEc8ae16Bf023C3119C38A04Fb054A19bAc5`
  - `token0`: Robinhood Chain `WETH` (`0x0bd7d308f8e1639fab988df18a8011f41eacad73`)
  - `token1`: Robinhood Chain `VIBES` (`0x9A73D60b9c8C2d330EB6D885E69fCc1399c33C18`)
- **Base Native `USDC`:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)
- **Universal `Permit2`:** `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- **Vibestarter Base Contracts (`docs/contracts/vibestarter-base.json`):**
  - `VibesLaunchRouterV2`: `0x783a7DB4113DC35A87dA43319af3cA7E6428f4BC`
  - `VibesTranchEscrowFactory`: `0x36C7e2d87F4E2d33b70304EbaA81eE88CB04Bf86`
  - `VibesTranchEscrow` (implementation): `0xcBe7e9E13576838eb4B55d0793Fd1CFFC1Dea43d`
  - `VibesRegistry` (Origin Capsule AI provenance): `0x66b74176F53d3081a87F75e10aD6cF554174Aef9`
  - `VibesTokenFactory`: `0x3671DBD5CFaF1D0D5c15a18b65F2CC7AcC7faE29`
  - **Live Genesis `$VIBES` Tranche Escrow (123.46 ETH raised):** `0x0e9bf34baed84a80d7647dafe4db52169147c911`

---

## 4. `Fundable` (`fundable.vibestarter.xyz`) Crawler Optimization Rules

Vibestarter's `Fundable` scorer uses Claude to fetch your root URL **and crawl every internal link on it**, scoring **Idea (60) / Execution (40)** across *Problem, Differentiation, Timing, and Backer Fit*.

1. **Server-Render Meaningful Content on `/`:** Never hide the entire landing page behind a client-only spinner or a mandatory `"Connect Wallet"` modal. Pre-load live server-fetched telemetry on `/` and provide 1-click Mainnet demo targets immediately.
2. **Ship Linked Semantic Subpages:** Include clear header/footer links to:
   - `/how-it-works` — Concrete problem statement, architecture, EVM bytecode + AMM math + `EIP-5792` rescue mechanics, and why Base + Robinhood Chain need overnight defense now.
   - `/token` — Non-security utility design for `$KEST` (compute/watcher slot staking, `x402` agent firewall credits, Panic Bunker automation tiers) + honest risk disclosure.
   - `/agents` — Documentation for `/api/v1/guard` (`x402`), `/api/mcp`, and `/llms.txt`.
3. **Keep `/llms.txt` Accurate:** Maintain `public/llms.txt` so AI judges (Claude & GPT) can parse the entire product and API surface in one fetch.

---

## 5. Strict Engineering Invariants (Never Violate)

- **Zero Fake/Mock Data:** Every price, reserve, bytecode flag, bridge balance, and escrow tranche status must come from live RPC calls or Vibestarter's verified public API (`https://app.vibestarter.xyz/api/campaigns`), with explicit block numbers and explorer links. If an optional external API (e.g., Anthropic key for AI summary) is missing, generate a deterministic rule-based briefing from real onchain metrics rather than failing or showing fake text.
- **`BigInt` Everywhere:** Never cast `uint256` / `uint160` (`sqrtPriceX96`) token amounts to JS `Number` before scaling decimals. Use `viem`'s `formatUnits` / `parseUnits` and `BigInt` arithmetic.
- **Non-Custodial Security:** Never request, accept, or log private keys. All wallet interactions run client-side via `wagmi` / `viem` EIP-1193 / EIP-6963 / EIP-5792.
- **Always Simulate Writes:** Call `publicClient.simulateContract` before invoking `writeContract` or `sendCalls`, and render human-readable error decoding if a simulation reverts.
- **Plain-Text Sanitization:** Render all external token names, symbols, and campaign titles as plain text—never `dangerouslySetInnerHTML`.

---

## 6. Developer Commands

```bash
# 1. Verify live Base + Robinhood Chain RPCs, OFT parity, DEX pools & Vibestarter Escrow (works immediately with Node 20+, zero npm install required!)
node scripts/verify-onchain.mjs

# 2. Install dependencies
npm install

# 3. Start local dev server
npm run dev

# 4. Typecheck & production build check (run before every commit!)
npm run typecheck
npm run build
```

### Custom Claude Code Slash Commands Included
- `/kickoff` — Install packages, run live onchain verification, and build the core Next.js App Router application end-to-end.
- `/verify-onchain` — Execute `scripts/verify-onchain.mjs` and validate all RPC & contract integrations.
- `/audit-fundable` — Audit all routes, SSR output, UX states, and rubric alignment for a 90+ Vibeathon & Fundable score.
