Audit the entire Kestrel application against BOTH the **Vibeathon 02 Judging Rubric** and **`fundable.vibestarter.xyz`**'s Claude crawler criteria:

1. **SSR & Crawler Legibility (`Fundable` Idea 60 / Execution 40):**
   - Start or build the app and inspect raw server-rendered HTML on `/`, `/how-it-works`, `/token`, `/agents`, and `/rescue`.
   - Confirm `/` renders clear value proposition, live pre-fetched telemetry, and navigation links to `/how-it-works`, `/token`, `/agents`, and `/llms.txt` without requiring JavaScript execution or wallet connection first.
2. **Vibeathon Rubric Check:**
   - **Execution (30%):** Test every API endpoint and interactive tab with real Base & Robinhood Chain addresses.
   - **Launch Potential (25%) & `$VIBES` Voter Appeal:** Confirm `$VIBES` cross-chain parity, Vibestarter Backer Shield, `x402` agent monetization, and `$KEST` utility documentation are front-and-center and crystal clear.
   - **Originality (20%) & Craft/UX (15%):** Check mobile + desktop layout, tabular monospace alignment, explorer deep-links (`↗`), and absence of generic AI-slop styling.
   - **Vibecoding Leverage (10%):** Confirm `/llms.txt`, `/api/mcp`, and `/api/openapi.json` all return valid, well-structured responses.
3. Report concrete scores out of 100 and fix any gaps immediately.
