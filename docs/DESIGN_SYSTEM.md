# Kestrel (`$KEST`) — "Night Shift" Design System Spec

> **Aesthetic North Star:** *A 10-storey glass & concrete operations desk at 03:42 UTC in the rain, lit by a sharp phosphor `>_` prompt on the roof while the city sleeps.*
> Inspired directly by **Vibestarter's** dark editorial + terminal visual grammar—engineered to earn **15/15 on Craft & UX**.

---

## 1. Color Palette (CSS Custom Properties)

```css
:root {
  /* Core Surfaces */
  --bg-canvas: #07090D;        /* Deep rain-obsidian primary background */
  --bg-surface: #0C1017;       /* Card & terminal panel surface */
  --bg-elevated: #121822;      /* Hover / drawer / modal surface */
  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.16);

  /* Typography */
  --text-primary: #F3F6FA;
  --text-secondary: #9BA7B8;
  --text-muted: #5F6B7C;

  /* Signal & Brand Accents */
  --accent-phosphor: #91D982;  /* Primary terminal green (`>_` nominal state, matches Vibestarter accent) */
  --chain-base: #38BDF8;       /* Base (8453) chain badge */
  --chain-robinhood: #C8FF00;  /* Robinhood Chain (4663) neon badge */
  --signal-warn: #FFB020;      /* Elevated risk / spread / active challenge window */
  --signal-critical: #FF4D4F;  /* Critical threat / Panic Bunker action */
}
```

---

## 2. Typography Pairing

Load via `next/font/google` in `src/app/layout.tsx`:
- **Display / Editorial Headlines:** `Instrument Serif` or `Newsreader` (gives high-craft editorial contrast against raw terminal data—identical to top-tier Base/Vibestarter editorial polish).
- **UI Body Copy:** `Inter` or `Plus Jakarta Sans` (clean, legible at `13px–15px`).
- **Telemetry, Hashes, Numbers & Badges:** `JetBrains Mono` or `IBM Plex Mono` with `font-variant-numeric: tabular-nums` so live ticking block numbers, countdowns, and token reserves never jitter horizontally.

---

## 3. Signature UI Details (Anti-AI-Slop Rules)

1. **NO Purple/Pink SaaS Gradients, NO Glowing Floating Orbs, NO Emoji-Stuffed Cards.**
2. **Sharp 1px Hairline Grids (`border-white/[0.08]`):** Use crisp architectural borders (`rounded-none` or `rounded-sm` max `2px–4px`), uppercase monospace section labels (`[ 01 // OVERNIGHT BRIEFING ]`), and live status dots (`● NOMINAL`).
3. **Top Live Dual-Chain Telemetry Ribbon:**
   - Persistent top bar displaying live block numbers for **BASE `#53,497,xxx`** (`#38BDF8` dot), **ROBINHOOD `#105,793,xxx`** (`#C8FF00` dot), **`$VIBES` OFT 1:1 PARITY (`VERIFIED`)**, and a **`04:00 NIGHT SHIFT ACTIVE >_`** indicator.
4. **Zero-Gate Landing Hero:**
   - Immediately beneath a concise one-line pitch + address omnibar, render **4 clickable Live Mainnet Preset Chips** (`LIVE_DEMO_PRESETS`) and **auto-load Preset #1 on initial page render** so judges and `Fundable` see real Mainnet telemetry within 1 second of opening the URL.
5. **Explorer Proof Links Everywhere:**
   - Every contract address, pool, adapter, and transaction hash must render with a subtle `↗` link directly to `basescan.org` or `robinhoodchain.blockscout.com` so technical judges can verify every single claim in one click.
