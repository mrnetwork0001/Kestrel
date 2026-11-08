# Kestrel: 5-Day Winning Execution Roadmap

> Historical plan from 2026-11-04, kept for reference. The token idea was dropped: there is no Kestrel token, and `/token` now redirects to `/how-it-works`.

> **Current Window:** Nov 4, 2026 → **Monday, Nov 9, 2026 at 22:00 UTC (Hard Cutoff)**
> *Remember: Submissions on `app.vibestarter.xyz/vibeathon/submit` stay editable until Nov 9 at 22:00 UTC. Deploy early (by Day 3) and submit an initial live URL early so you never risk last-minute deployment issues!*

---

## Day 1 (Wed Nov 4): Foundation + Dual-Chain Core Engine
- [ ] Run `node scripts/verify-onchain.mjs` to confirm live Base + Robinhood Chain RPC telemetry.
- [ ] Install Next.js 15 + Tailwind v4 + `viem` + `wagmi` (`npm install`).
- [ ] Build the Night Shift shell (`src/app/layout.tsx`) with the live Base (`8453`) + Robinhood Chain (`4663`) block ticker, wallet connect (`wagmi` injected + Coinbase Smart Wallet), and navigation (`/`, `/how-it-works`, `/agents`, `/rescue`).
- [ ] Implement `/api/parity` & `/api/scan` routes reading real Base + Robinhood Chain contracts, bytecode (`inspectRawBytecode`), EIP-1967 proxy slots, and pool reserves.

## Day 2 (Thu Nov 5): Interactive Workspace (Features 1, 3, 4, 5, 6)
- [ ] Build the unified **Night Shift Sentinel Workspace** on `/` with zero-auth instant preset loading:
  - **Tab 1 — Night Shift Briefing & Bytecode X-Ray:** Threat score (`0–100`), wallet/contract scan, EIP-1967 proxy & multisig check, and `/api/brief` AI/deterministic Morning Desk Brief.
  - **Tab 2 — Simulate the Rug (Chaos Lab):** Interactive LP pull (`0–90%`) + Whale dump (`0–10%`) sliders running `simulateConstantProductShock` on live pool reserves.
  - **Tab 3 — Base ↔ Robinhood Parity Radar:** Live `$VIBES` 1:1 OFT Proof-of-Reserve meter + Aerodrome vs Uniswap v3 cross-chain spread % calculator.
  - **Tab 4 — Vibestarter Backer Shield:** Live `VibesTranchEscrow` tranche timeline, **live 72-hour challenge countdown**, permanent LP lock badge, and Origin Capsule verification.

## Day 3 (Fri Nov 6): Atomic Panic Bunker (`EIP-5792`) + Agent `x402` & MCP + First Vercel Deploy
- [ ] Build `/rescue` & the inline **Panic Bunker Drawer**:
  - Scans connected wallet's active `ERC-20` + `Permit2` approvals on Base.
  - Executes `publicClient.simulateContract` preflight checks.
  - Sends **1-Click Atomic Rescue Batch (`wallet_sendCalls` / EIP-5792)** with automatic sequential `writeContract` fallback + calldata preview mode.
- [ ] Build `/api/v1/guard` (HTTP `402 Payment Required` `x402` Base USDC gate + preview mode), `/api/mcp` (Streamable HTTP MCP server), `/api/openapi.json`, and `/api/pager/test` (live webhook/Telegram pager).
- [ ] **Deploy v1 to Vercel** and open your draft submission on `app.vibestarter.xyz/vibeathon/submit` so a working URL is safely banked 72 hours early!

## Day 4 (Sat Nov 7): `Fundable` Crawler Optimization (`Idea 60 / Execution 40`)
- [ ] Complete `/how-it-works` and `/agents` SSR pages with crystal-clear problem framing, differentiation vs passive scanners, and the Base + Robinhood timing thesis.
- [ ] Paste your live Vercel URL into **[fundable.vibestarter.xyz](https://fundable.vibestarter.xyz)**.
- [ ] Read Claude's `Fundable` critique line by line, tighten any weak spot on copy, UX, or linked pages, and re-score until Kestrel hits **`FUNDABLE`**!

## Day 5 (Sun Nov 8 – Mon Nov 9 before 22:00 UTC): Final Polish & Submission Lock
- [ ] Test mobile responsiveness (`375px` width), error boundaries, RPC timeout fallbacks, and wallet switching between Base (`8453`) and Robinhood Chain (`4663`).
- [ ] Attach your `fundable.vibestarter.xyz` result link + crisp 1-line pitch + live Vercel URL on `app.vibestarter.xyz/vibeathon/submit` **at least 4 hours before 22:00 UTC on Monday, Nov 9**.

---

## Ready-to-Use Submission Copy Draft

- **Name:** Kestrel
- **One-Line Pitch:** Autonomous overnight risk, atomic rescue (`EIP-5792`), and Base ↔ Robinhood Chain parity & escrow sentinel—built for humans who sleep and AI agents (`x402`/MCP) that don't.
- **Risk Disclosure Reminder (footer):** *"Onchain interactions carry risk; nothing in Kestrel constitutes financial advice."*
