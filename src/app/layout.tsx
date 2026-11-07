import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { Suspense, type ReactNode } from "react";
import { Providers } from "@/components/providers";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { TelemetryRibbon } from "@/components/telemetry-ribbon";
import { siteUrl } from "@/lib/site";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument-serif" });
const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "Kestrel ($KEST) — Overnight Sentinel for Base & Robinhood Chain", template: "%s · Kestrel" },
  description:
    "Autonomous overnight risk, liquidity, bridge parity, and tranche-escrow sentinel for Base & Robinhood Chain. Live onchain threat scores, EIP-5792 atomic Panic Bunker, rug stress tests, $VIBES OFT parity, and Vibestarter Backer Shield.",
  openGraph: {
    title: "Kestrel — Stay asleep. Kestrel watches the chain.",
    description: "Live overnight defense desk for Base (8453) & Robinhood Chain (4663).",
    type: "website",
  },
  alternates: { canonical: "/" },
};

export const viewport: Viewport = { themeColor: "#07090D" };

function RibbonFallback() {
  return <div className="h-[29px] border-b hairline" />;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <Providers>
          <Suspense fallback={<RibbonFallback />}>
            <TelemetryRibbon />
          </Suspense>
          <SiteHeader />
          <main>{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
