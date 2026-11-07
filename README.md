# Kestrel (`$KEST`) `>_`

**Autonomous overnight risk, atomic rescue (`EIP-5792`), cross-chain parity, and tranche-escrow sentinel for Base & Robinhood Chain.**
*Built for Vibestarter **Vibeathon 02: Night Shift**.*

> *"Stay asleep. Kestrel watches the chain."*

---

## Why Kestrel Exists

DeFi liquidity pools, cross-chain LayerZero bridges, and time-released raise escrows operate 24/7—human traders and backers don't. Most losses happen on the **night shift**: an unguarded proxy upgrades at 03:00 UTC, a whale drains thin liquidity, a cross-chain pool drifts out of parity, or a 72-hour escrow challenge window quietly expires.

**Kestrel** turns passive block explorers into an active, non-custodial overnight defense desk for **humans** and **autonomous AI agents (`x402` + MCP)**.

---

## Core Capabilities

1. **"While You Slept" 8-Hour Night Shift Briefing:** Paste any wallet, token, pool, or escrow on **Base (`8453`)** or **Robinhood Chain (`4663`)**—or click a live Mainnet preset with zero wallet-connect friction—for an instant `0–100` threat score and plain-English Morning Desk Brief.
2. **1-Click Atomic "Panic Bunker" (`EIP-5792`):** Batches risky `ERC-20` + `Permit2` approval revokes and emergency exits into **one single atomic signature** (`wallet_sendCalls`) on Base Smart Wallets, with guided sequential fallback for standard EOAs.
3. **Interactive "Simulate the Rug" Chaos Lab:** Stress-test live Aerodrome (`getReserves`) and Uniswap v3 (`slot0` `sqrtPriceX96`) pools against whale dumps and LP pulls using exact `BigInt` AMM math.
4. **Live Base ↔ Robinhood Chain Parity & Spread Radar:** Verifies exact 1:1 LayerZero OFT Proof-of-Reserve (`Base locked == Robinhood circulating`) and tracks live cross-venue DEX price spreads in basis points.
5. **Vibestarter Backer Shield:** Monitors live `VibesTranchEscrow` contracts on Base—tracking 10% kickstart + 15% monthly tranche unlocks, **live 72-hour challenge countdowns**, permanent LP locks, and Origin Capsule AI provenance.
6. **Raw EVM Bytecode & EIP-1967 Proxy X-Ray:** Scans `eth_getCode` and EIP-1967 storage slots directly via RPC to detect hidden `mint`, `blacklist`, `pause`, and EOA-controlled proxy upgrade paths.
7. **Agent Security Firewall (`x402` USDC + MCP + `/llms.txt`):** Pre-trade `ALLOW | WARN | BLOCK` API gated by Base `x402` USDC micropayments (`/api/v1/guard`) alongside a Streamable HTTP MCP server (`/api/mcp`).
8. **Night-Shift Pager:** Webhook and Telegram alert dispatches carrying 1-click `/rescue` deep links straight into pre-staged Atomic Panic Bunker bundles.

---

## Quickstart

```bash
# 1. Verify live Base (8453) & Robinhood Chain (4663) RPC telemetry immediately
node scripts/verify-onchain.mjs

# 2. Configure environment (optional — all core onchain reads work without API keys)
cp .env.example .env.local

# 3. Install & run locally
npm install
npm run dev
```

The landing page (`/`) is server-rendered with live telemetry; the interactive workspace lives at **`/app`**.

**Optional env vars** (see `.env.example`):

- `NEXT_PUBLIC_APP_URL` — canonical URL for a custom domain (on Vercel it is auto-detected).
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) — Upstash Redis for shared rate limits and response caching across serverless instances; in-memory when unset.
- `ZG_COMPUTE_API_KEY` / `ANTHROPIC_API_KEY` — LLM Morning Desk Brief (a deterministic onchain brief is used otherwise).
- `X402_RECEIVER_ADDRESS`, `X402_PRICE_USDC_ATOMIC`, `X402_FACILITATOR_URL` — paid `mode=full` on `/api/v1/guard`.
- `TELEGRAM_BOT_TOKEN`, `CRON_SECRET` — Night-Shift Pager delivery and the scheduled pager tick.
- `GITHUB_TOKEN` — higher GitHub API limits for founder velocity.
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `NEXT_PUBLIC_*_RPC_URL` — WalletConnect and RPC overrides.

---

## Project Layout

- `CLAUDE.md` — Master engineering specification, rubric strategy, and strict safety invariants.
- `CLAUDE_CODE_STARTER_PROMPTS.md` — Turn-key build prompts & slash commands (`/kickoff`, `/verify-onchain`, `/audit-fundable`).
- `.mcp.json` — Pre-wired HTTP MCP connection to Vibestarter (`https://app.vibestarter.xyz/mcp`).
- `docs/ARCHITECTURE.md` — Full system topology, API routes, and 8-module breakdown.
- `docs/DESIGN_SYSTEM.md` — Night Shift visual tokens, typography, and anti-AI-slop rules.
- `docs/ROADMAP_5_DAYS.md` — Day-by-day execution & `Fundable` scoring checklist.
- `docs/contracts/vibestarter-base.json` — Verified Vibestarter Base Mainnet contract ABIs & addresses.
- `src/config/` & `src/lib/` — Live-verified chain definitions, contract addresses, minimal ABIs, `BigInt` AMM simulator, and raw EVM bytecode scanner.
- `scripts/verify-onchain.mjs` — Zero-dependency live dual-chain RPC smoke verifier.

---

## Risk Disclosure

`$KEST` is a proposed utility token concept for protocol compute access and watcher tiers, not a security or investment contract. Onchain transactions carry significant risk; nothing in Kestrel constitutes financial advice.
