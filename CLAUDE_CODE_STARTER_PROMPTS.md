# Claude Code Starter Prompts for Kestrel (`$KEST`)

Everything in this repository is pre-configured for **Claude Code**—including `CLAUDE.md`, `.mcp.json` (connected to Vibestarter's live MCP server at `https://app.vibestarter.xyz/mcp`), verified Base (`8453`) + Robinhood Chain (`4663`) contracts/RPCs, AMM math, bytecode scanner helpers, and custom slash commands in `.claude/commands/`.

---

## Step 1: Launch Claude Code

```bash
cd /Users/mrnetwork/Kestrel
cp .env.example .env
claude
```

---

## Step 2: Run the Master Build (`/kickoff` or Paste Prompt 1)

Inside Claude Code, you can simply run:

```text
/kickoff
```

**Or** if you prefer building in controlled, reviewable stages, paste these three prompts one by one:

### Prompt 1 — Backend Onchain Engine & APIs
```text
Read CLAUDE.md, docs/ARCHITECTURE.md, and src/config/contracts.ts in full.
First run `node scripts/verify-onchain.mjs` and `npm install`.
Then build all live backend API routes under src/app/api/:
1. /api/scan — Unified live Base (8453) & Robinhood Chain (4663) scanner for wallets, ERC-20 tokens, and DEX pools, combining ERC-20/Permit2 allowance checks, raw bytecode inspection (src/lib/bytecode-signatures.ts), EIP-1967 proxy storage slot reads, Safe multisig owner checks, and composite Kestrel Threat Score (0-100).
2. /api/parity — Live $VIBES LayerZero OFT 1:1 Proof-of-Reserve check + Base Aerodrome vs Robinhood Uniswap v3 spot price dislocation bps.
3. /api/backer-shield — Live Vibestarter VibesTranchEscrow + /api/campaigns reader tracking tranche schedules, 72-hour active challenge countdowns, permanent LP locks, and Origin Capsule hashes.
4. /api/brief — AI Morning Desk Brief endpoint (uses ANTHROPIC_API_KEY if configured, with a rich deterministic onchain analyst brief fallback when unset).
5. /api/v1/guard, /api/mcp, /api/pager/test, and /api/openapi.json.
Verify every route against live Mainnet RPCs with zero mock data.
```

### Prompt 2 — "Night Shift" Frontend Workspace & Atomic Panic Bunker
```text
Read docs/DESIGN_SYSTEM.md strictly (#07090D obsidian canvas, #91D982 phosphor terminal green >_, Base #38BDF8 & Robinhood #C8FF00 badges, Instrument Serif + Inter + JetBrains Mono tabular-nums, sharp 1px architectural hairlines, zero purple gradients).
Build the complete frontend:
1. Top live dual-chain telemetry bar (Base block, Robinhood block, 1:1 OFT parity badge, wallet connect supporting EIP-5792 Smart Wallets + standard EOAs).
2. SSR landing page `/` with zero wallet-connect gate, 4 instant 1-click Mainnet presets (auto-loading Preset #1), address omnibar, and interactive tabs for:
   - Overnight Briefing & Bytecode X-Ray
   - Interactive "Simulate the Rug" Chaos Stress-Tester (live sliders using simulateConstantProductShock)
   - Base <-> Robinhood Parity & Spread Radar
   - Vibestarter Backer Shield (with live 72-hour challenge window countdown)
   - Night-Shift Pager (live webhook/Telegram test dispatch)
3. `/rescue` & inline Atomic Panic Bunker drawer using EIP-5792 `wallet_sendCalls` batch approval revokes + sequential `writeContract` fallback + `simulateContract` preflight + calldata preview mode.
```

### Prompt 3 — `Fundable` SSR Pages, QA & Production Build Verification
```text
Build the server-rendered `/how-it-works`, `/token`, and `/agents` (including an interactive x402 HTTP 402 handshake playground and copyable MCP config) pages optimized for Vibestarter's `fundable.vibestarter.xyz` Claude crawler.
Then run `/verify-onchain`, `/audit-fundable`, `npm run typecheck`, and `npm run build`, fixing every issue until the production build passes cleanly with zero errors.
```
