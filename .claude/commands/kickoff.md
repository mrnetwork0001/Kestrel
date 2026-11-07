Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, and `docs/DESIGN_SYSTEM.md` in full first.

Then execute the complete Kestrel MVP build systematically:
1. Run `node scripts/verify-onchain.mjs` first to verify live Base (8453) and Robinhood Chain (4663) RPC responses and inspect real live values.
2. Install dependencies (`npm install`) and verify TypeScript compilation.
3. Build the backend API routes (`src/app/api/scan/route.ts`, `src/app/api/parity/route.ts`, `src/app/api/backer-shield/route.ts`, `src/app/api/brief/route.ts`, `src/app/api/v1/guard/route.ts`, `src/app/api/mcp/route.ts`, `src/app/api/pager/test/route.ts`, `src/app/api/openapi.json/route.ts`) using 100% live RPC reads (`src/lib/rpc.ts`, `src/config/contracts.ts`, `src/lib/abis.ts`, `src/lib/amm-math.ts`, `src/lib/bytecode-signatures.ts`) with ZERO mock/fake data.
4. Build the Night Shift UI shell (`src/app/layout.tsx`, `src/app/globals.css`, `wagmi` provider) strictly following `docs/DESIGN_SYSTEM.md` (`#07090D` obsidian canvas, `#91D982` phosphor terminal green, Base `#38BDF8` & Robinhood `#C8FF00` badges, tabular monospace telemetry).
5. Build the interactive landing workspace (`src/app/page.tsx`) with zero-wallet-gate instant preset loading across all core tabs (Overnight Briefing & Bytecode X-Ray, Simulate the Rug Chaos Lab, Base ↔ Robinhood Parity Radar, Vibestarter Backer Shield, Panic Bunker Drawer, and Night-Shift Pager).
6. Build `/rescue`, `/how-it-works`, `/token`, and `/agents` SSR pages optimized for `fundable.vibestarter.xyz`.
7. Run `npm run typecheck` and `npm run build` and fix every warning or error until clean.
