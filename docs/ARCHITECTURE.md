# Kestrel: System Architecture & Feature Spec

> Original build spec, kept for reference. There is no Kestrel token (the old `/token` page now redirects to `/how-it-works`). For the system as built, see the [README](../README.md) architecture section and [DEPLOY.md](DEPLOY.md).

## 1. High-Level System Topology

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                        KESTREL NEXT.JS 15 APP ROUTER                       │
│  SSR Semantic Pages (/ , /app , /how-it-works , /agents , /rescue)         │
│  Optimized for Human Judges, $VIBES Voters & Fundable Claude Crawler       │
└───────────────┬────────────────────────────────────────┬───────────────────┘
                │                                        │
   ┌────────────▼────────────┐              ┌────────────▼────────────┐
   │  ONCHAIN ENGINE (VIEM)  │              │  AGENT & ALERT ENGINE   │
   │  • Base RPC (8453)      │              │  • /api/v1/guard (x402) │
   │  • Robinhood RPC (4663) │              │  • /api/mcp (HTTP MCP)  │
   │  • Bytecode & Slot Scan │              │  • /api/pager (Webhook) │
   │  • AMM Shock Simulator  │              │  • /api/brief (Claude)  │
   └────────────┬────────────┘              └────────────┬────────────┘
                │                                        │
   ┌────────────▼────────────────────────────────────────▼────────────┐
   │                NON-CUSTODIAL WALLET EXECUTION LAYER              │
   │  • EIP-5792 Atomic Batch (`wallet_sendCalls`) on Base            │
   │  • Sequential `writeContract` Fallback + `simulateContract` Gate │
   └──────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Specification of the 8 Core Features

### Feature 1: "While You Slept" 8-Hour Night Shift Briefing
- **Input:** Any wallet EOA/Smart Account, ERC-20 token, DEX pool, or Vibestarter Escrow address on Base (`8453`) or Robinhood Chain (`4663`) — plus 4 instant 1-click hero presets (`LIVE_DEMO_PRESETS` in `src/config/contracts.ts`).
- **Telemetry Computed:**
  - Composite **Kestrel Threat Score (`0–100`)** mapped to `NOMINAL (0–29)`, `ELEVATED (30–64)`, or `CRITICAL (65–100)`.
  - Wallet mode: native ETH balance, tracked ERC-20 holdings, active `allowance()` & `Permit2` exposures across `CONTRACTS.base.commonSpenders`, and net exposure at risk.
  - Token/Contract mode: supply, owner/admin key posture, bytecode risk flags, primary pool depth, and cross-chain parity.
  - **Morning Desk Brief:** Calls `/api/brief` (0G Compute when `ZG_COMPUTE_API_KEY` + `ZG_COMPUTE_MODEL` are set, then `ANTHROPIC_API_KEY`; otherwise generates a crisp, deterministic analyst brief directly from the live onchain findings so the UI never errors without keys).

### Feature 2: 1-Click Atomic "Panic Bunker" (`EIP-5792` Batch Rescue)
- **Problem Solved:** At 3:00 AM during an exploit, signing 8 separate `approve(spender, 0)` popups in MetaMask takes too long and fails halfway.
- **Implementation:**
  1. Scan connected wallet's active ERC-20 allowances (`allowance > 0n`) and `Permit2` allowances.
  2. Let user check/uncheck risky approvals + optional emergency token-to-USDC unwind calls.
  3. Run `publicClient.simulateContract` on each call to verify zero reverts and show exact gas / outcome preview.
  4. Check `useCapabilities` / `wallet_getCapabilities` for `atomicBatch.supported === true`:
     - **Supported (Coinbase Smart Wallet, Safe, Ambire):** Dispatch a single `sendCalls({ calls })` atomic bundle!
     - **Standard EOA Fallback:** Step through a clean visual stepper (`1/N Signed...`) with live Basescan tx links.
  5. Also include a **"Preview Rescue Calldata (Demo Mode)"** drawer so judges inspecting without connecting a wallet can still verify the exact encoded `0x095ea7b3...` batch payload!

### Feature 3: Interactive "Simulate the Rug" Chaos Stress-Tester
- **UI Controls:**
  - Slider 1: **LP Removal Shock (`0%` → `90%`)**
  - Slider 2: **Whale Market Dump (`0%` → `10%` of circulating supply)**
  - Preset Scenario Buttons: `[Nominal Market]`, `[Top Whale Exits]`, `[50% Rug Pull]`, `[Black Swan Cascade]`
- **Math Engine:** Uses `simulateConstantProductShock` in `src/lib/amm-math.ts` seeded with **live** `getReserves()` from Base Aerodrome (or equivalent virtual reserves from Robinhood Uniswap v3 `slot0` + `liquidity`). Displays pre-shock vs post-shock WETH exit value and exact drawdown %.

### Feature 4: Base ↔ Robinhood Chain Bridge Parity & Spread Radar
- **Live Verification (`src/app/api/parity/route.ts` or Server Component):**
  - Reads `VIBES.balanceOf(baseBridgeAdapter)` on Base (`8453`).
  - Reads `VIBES.totalSupply()` and `VIBES.balanceOf(rhReserveAdapter)` on Robinhood Chain (`4663`).
  - Verifies `lockedOnBase === totalSupplyRH - reserveOnRH` (displaying exact 1:1 proof badge + explorer links to both adapters!).
  - Reads Base Aerodrome `WETH/VIBES` pool (`0x07F78058685b75F89288f025a0a154A96021Ac45`) vs Robinhood Chain Uniswap v3 `WETH/VIBES` 1% pool (`0x3A9BFEc8ae16Bf023C3119C38A04Fb054A19bAc5`), calculates live basis-point dislocation, and shows which chain trades at a premium + bridge headroom reminder (10M–30M OFT rate limit).

### Feature 5: Vibestarter "Backer Shield" (Tranche & 72h Challenge Watchdog)
- **Data Sources:**
  - Onchain: `VibesTranchEscrowFactory.getAllEscrows()`, `VibesTranchEscrow.getEscrowBalance()`, `trancheClaimed(i)`, `trancheRequestedAt(i)`, `trancheChallenged(i)`, `VibesRegistry.capsuleHashOf(token)`.
  - Public API enrichment: `https://app.vibestarter.xyz/api/campaigns` & `/api/campaigns/by-tx/vibes`.
- **Key UX Highlight:** Displays a timeline of all 7 payouts (`10% Kickstart` + `6 × 15% Monthly`), live countdown timer whenever a tranche is in `REQUESTED` state (`72-hour Backer Challenge Window`), verified permanent LP lock tx link, Origin Capsule AI provenance status, and founder Ethos/GitHub signals.

### Feature 6: Raw EVM Bytecode & EIP-1967 Storage-Slot X-Ray
- **Data Sources:**
  - `publicClient.getCode({ address })` -> passed to `inspectRawBytecode()` (`src/lib/bytecode-signatures.ts`).
  - `publicClient.getStorageAt({ address, slot: PROXY_STORAGE_SLOTS.eip1967Implementation })` & `eip1967Admin`.
  - If `owner()` exists, check `publicClient.getCode({ address: owner })` and `SAFE_MULTISIG_ABI` (`getThreshold()`, `getOwners()`) to distinguish a dangerous single EOA owner from a `2-of-3` Safe Multisig or renounced `0x000...000` owner!

### Feature 7: Agent Security Firewall (`x402` Base USDC + MCP)
- **`GET / POST /api/v1/guard`:**
  - Query params / JSON body: `{ address, chainId, mode: "preview" | "full" }`.
  - In `preview` mode (or with valid `X-PAYMENT` Base USDC transfer receipt / demo bypass toggle in UI playground): returns `{ verdict: "ALLOW" | "WARN" | "BLOCK", riskScore, flags, bridgeParity, poolDepthWeth, blockNumber, timestamp }`.
  - If `mode=full` without `X-PAYMENT` header: returns **HTTP `402 Payment Required`** with standard `x402` payment metadata (`chainId: 8453`, `asset: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `receiver`, `amountAtomic: "10000"` = `0.01 USDC`) so judges can watch an interactive **"Agent x402 Handshake"** right inside `/agents`!
- **`POST /api/mcp`:**
  - JSON-RPC 2.0 MCP endpoint supporting `initialize`, `tools/list`, and `tools/call` for 11 tools: `scan_contract`, `check_bridge_parity`, `simulate_exit`, `inspect_vibestarter_escrow`, `challenge_copilot`, `challenge_dry_run`, `ecosystem_health`, `vibestarter_pulse`, `create_watch`, `list_watches`, `delete_watch`.

### Feature 8: Night-Shift Pager (Webhook / Telegram Deep-Links)
- **`POST /api/pager/test`:**
  - Accepts a user's Discord/Slack/Custom Webhook URL (or Telegram chat ID when `TELEGRAM_BOT_TOKEN` is set) plus armed thresholds (`maxSpreadBps`, `minLpWeth`, `watchChallengeWindows`).
  - Fires a real formatted **Kestrel Night-Shift Pager Alert** containing live block metrics and a 1-click `/rescue?target=...` deep link!

---

## 3. Recommended Route Map

```text
src/app/
├── layout.tsx                 # Dark Night-Shift shell, live Base/RH block ticker, nav + footer
├── page.tsx                   # SSR Hero + 1-Click Presets + Unified Sentinel Workspace Tabs
├── how-it-works/page.tsx      # Deep technical explainer (for Judges & Fundable crawler)
├── app/page.tsx               # Six-tab Sentinel workspace (Briefing, Rug Lab, Parity, Backer Shield, Panic Bunker, Pager)
├── ecosystem/page.tsx         # Vibestarter Ecosystem Health Board
├── agents/page.tsx            # Interactive x402 Playground + MCP copy-paste config
├── rescue/page.tsx            # Dedicated EIP-5792 Atomic Panic Bunker deep-link view
└── api/
    ├── scan/route.ts          # Unified live RPC scan (wallet / token / pool / bytecode)
    ├── parity/route.ts        # Live Base <-> Robinhood Chain OFT & DEX spread endpoint
    ├── backer-shield/route.ts # Live Vibestarter Escrow + Tranche 72h Challenge feed
    ├── brief/route.ts         # Claude AI / deterministic Morning Desk Brief generator
    ├── pager/test/route.ts    # Live Webhook / Telegram test alert dispatcher
    ├── v1/guard/route.ts      # HTTP 402 (x402 USDC) pre-trade agent firewall
    ├── mcp/route.ts           # Streamable HTTP MCP server
    └── openapi.json/route.ts  # Machine-readable OpenAPI 3.1 spec
```
