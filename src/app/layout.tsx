import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { Suspense, type ReactNode } from "react";
import { RevealObserver } from "@/components/motion/reveal-observer";
import { Providers } from "@/components/providers";
import { RibbonGate } from "@/components/ribbon-gate";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { TelemetryRibbon } from "@/components/telemetry-ribbon";
import { siteUrl } from "@/lib/site";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument-serif" });
const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "Kestrel — Overnight Sentinel for Base & Robinhood Chain", template: "%s · Kestrel" },
  description:
    "Autonomous overnight risk, liquidity, bridge parity, and tranche-escrow sentinel for Base & Robinhood Chain. Live onchain threat scores, EIP-5792 atomic Panic Bunker, rug stress tests, $VIBES OFT parity, and Vibestarter Backer Shield.",
  openGraph: {
    title: "Kestrel — Stay asleep. Kestrel watches the chain.",
    description: "Live overnight defense desk for Base (8453) & Robinhood Chain (4663).",
    type: "website",
    siteName: "Kestrel",
  },
  // No root canonical: it would be inherited by every route and fold them all into "/". Each page sets its own.
};

export const viewport: Viewport = { themeColor: "#07090D" };

/**
 * Pre-paint motion flag. Adds <html class="js"> only when JS runs and the user has not asked for reduced motion; every
 * hidden-before-reveal state in globals.css is scoped to html.js, so no-JS, crawlers and reduced motion get the final
 * page. A plain inline <script> (string child, no `<`): next/script beforeInteractive defers inline code to the Next
 * runtime in the App Router, which would run after first paint.
 */
const JS_FLAG = `(function(){var d=document.documentElement;if(!window.matchMedia||!matchMedia('(prefers-reduced-motion: reduce)').matches){d.classList.add('js')}})()`;

function RibbonFallback() {
  return <div className="h-[29px] border-b hairline" />;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script id="kestrel-js-flag">{JS_FLAG}</script>
      </head>
      <body className="min-h-screen">
        <RevealObserver />
        <Providers>
          <RibbonGate>
            <Suspense fallback={<RibbonFallback />}>
              <TelemetryRibbon />
            </Suspense>
          </RibbonGate>
          <SiteHeader />
          <main>{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
