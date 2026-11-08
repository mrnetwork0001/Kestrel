import type { Metadata } from "next";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Suspense } from "react";
import { LIVE_DEMO_PRESETS } from "@/config/contracts";
import { DEMO_RESCUE_WALLET } from "@/config/demo";
import { ChainDot, InkLink, Wrap } from "@/components/editorial";
import { SentinelWatchLive } from "@/components/hero-sentinel/sentinel-watch-live";
import { LandingOmnibar } from "@/components/landing-omnibar";
import { AgentsSection } from "@/components/landing/agents";
import { getEscrow, getPulseSnap, getScan } from "@/components/landing/data";
import { FinalCtaSection } from "@/components/landing/final-cta";
import { InstrumentIndexSection } from "@/components/landing/instrument-index";
import { LedgerSection } from "@/components/landing/ledger";
import { ProblemSection } from "@/components/landing/problem";
import { presetTab } from "@/components/landing/shared";
import { SplitWords } from "@/components/motion";
import { SectionLabel } from "@/components/ui";

export const revalidate = 60;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/* Live reads live in src/components/landing/data.ts (React cache): the hero and every section share one scan, one parity
   read and one escrow read per render. */

/** Hero load delay (CSS-only keyframes under html.js + no-preference; plain visible markup otherwise). */
const hd = (ms: number) => ({ "--hd": `${ms}ms` }) as CSSProperties;

export default function Landing() {
  // Start every live read now; the Suspense sections pick up the same promises.
  void getScan();
  void getEscrow();

  return (
    <>
      {/* ───────────── S0 · HERO ───────────── */}
      <Wrap as="section" className="grid gap-10 pt-12 pb-10 max-[900px]:gap-8 max-[900px]:pt-7 max-[900px]:pb-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <SplitWords mode="load" as="h1" className="t-hero" parts={["Stay asleep.", "br", { em: "Kestrel" }, "watches the\u00a0chain."]} />
          <p className="hl t-body-l mt-6 max-w-[34rem] max-[600px]:mt-4" style={hd(300)}>
            Kestrel reads Base and Robinhood Chain over RPC all night, scores what changed while you slept, and stages a one-signature rescue for the moment it
            matters.
          </p>
          <div className="hl mt-6 max-w-2xl" style={hd(380)}>
            <LandingOmnibar />
          </div>
          <div className="mt-5 max-w-2xl">
            <span className="hl t-kicker block text-ink-meta" style={hd(460)}>
              Try live:
            </span>
            <div className="mt-1.5 grid grid-cols-2 gap-x-6 gap-y-0.5 max-[420px]:grid-cols-1">
            {LIVE_DEMO_PRESETS.map((p, i) => (
              <Link
                key={p.id}
                href={`/app?target=${p.targetAddress}&chain=${p.chainId}&tab=${presetTab(p.kind)}`}
                title={p.description}
                className="hl dot-link flex min-w-0 max-w-full items-center gap-2 py-1 text-[14px] max-[900px]:min-h-11"
                style={hd(460 + (i + 1) * 40)}
              >
                <ChainDot chainId={p.chainId} withText={false} className="dot" />
                <span className="truncate">{p.label}</span>
              </Link>
            ))}
            </div>
          </div>
          <div className="hl mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 max-[600px]:mt-6" style={hd(600)}>
            <Link href="/app" className="btn-primary press">
              LAUNCH APP
            </Link>
            <InkLink href={`/rescue?target=${DEMO_RESCUE_WALLET.address}&chain=8453`} className="text-[15px]">
              Preview a live rescue
            </InkLink>
            <InkLink href="/how-it-works" className="text-[15px]">
              How it works
            </InkLink>
            <InkLink href="https://youtu.be/uoDrMigaJfo" external className="text-[15px]">
              Watch the 3-min demo
            </InkLink>
          </div>
          <p className="hl t-meta mt-6" style={hd(680)}>
            No wallet connect · zero mock data · every number links to an explorer
          </p>
        </div>

        <div className="min-w-0">
          <Suspense fallback={<WatchSkeleton />}>
            <HeroWatch />
          </Suspense>
        </div>
      </Wrap>

      {/* Fold: the Ledger band's own top border is the full-bleed hair-strong rule that closes the hero. */}
      <LedgerSection />
      <ProblemSection />
      <InstrumentIndexSection />
      <AgentsSection />
      <FinalCtaSection />
    </>
  );
}

/** Hero instrument: real blocks + Permit2 / $VIBES logs replayed on a 60 s watch face (SSR snapshot, then live). */
async function HeroWatch() {
  const [pulse, scan, escrow] = await Promise.all([getPulseSnap(), getScan(), getEscrow()]);
  const open = escrow?.tranches.find((t) => t.status === "CHALLENGE_WINDOW") ?? null;
  return (
    <SentinelWatchLive
      initial={pulse}
      scan={scan && { score: scan.score, band: scan.band, block: scan.block.number, at: scan.block.timestamp }}
      escrow={escrow && { openEndsAt: open?.windowEndsAt ?? null, openLabel: open?.label ?? null, nextTranche: escrow.nextTranche }}
      brief={scan && { text: briefExcerpt(scan.brief?.text), topFinding: scan.findings[0]?.title ?? null }}
      nowSec={Math.floor(Date.now() / 1000)}
    />
  );
}

/** First sentence(s) of the Morning Desk Brief as plain text (≥ ~90 chars, ≤ 2 sentences, ≤ 240 chars). */
function briefExcerpt(text: string | undefined): string | null {
  const clean = (text ?? "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const parts = clean.split(/(?<=[.!?])\s+(?=[A-Z$])/);
  let out = parts[0];
  if (out.length < 90 && parts[1]) out = `${out} ${parts[1]}`;
  return out.length > 240 ? `${out.slice(0, 239).trimEnd()}…` : out;
}

function WatchSkeleton() {
  return (
    <section className="panel @container mono min-w-0 overflow-hidden" aria-busy="true">
      <header className="flex items-center justify-between gap-3 border-b hairline px-4 py-2.5 max-[601px]:px-3">
        <SectionLabel n="LIVE" className="min-w-0">Sentinel watch · K-60</SectionLabel>
        <span className="text-[11px] text-ink-meta">● SNAPSHOT</span>
      </header>
      <div className="h-[57px] border-b hairline" />
      <div className="px-3 py-4 @min-[560px]:px-[132px]">
        <div className="relative mx-auto flex aspect-square w-full max-w-[340px] items-center justify-center rounded-full border hairline @min-[560px]:max-w-[360px]">
          <p className="text-[11px] text-ink-meta cursor-blink">Reading Base &amp; Robinhood Chain</p>
        </div>
      </div>
      <div className="h-[37px] border-y hairline" />
      <div className="h-[120px]" />
      <div className="h-[33px] border-t hairline" />
    </section>
  );
}
