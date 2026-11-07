import Link from "next/link";
import { Kicker, Rule, Wrap } from "./editorial";
import { SplitWords } from "./motion";
import { HeaderNav, HeaderTail } from "./header-client";
import { MobileNav } from "./mobile-nav";

const NAV = [
  { href: "/app", label: "App" },
  { href: "/rescue", label: "Panic Bunker" },
  { href: "/ecosystem", label: "Ecosystem" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/agents", label: "Agents · x402 · MCP" },
  { href: "/token", label: "$KEST" },
];

export function SiteHeader() {
  return (
    // <=900px: sticky, blurred 56px top bar (brand | PANIC BUNKER + burger). >=901px: unchanged static header.
    // Tailwind v4 `max-[901px]:` compiles to `width < 901px`, i.e. <=900px, pairing exactly with `min-[901px]:`.
    <header className="border-b hairline max-[901px]:sticky max-[901px]:top-0 max-[901px]:z-30 max-[901px]:bg-canvas/85 max-[901px]:backdrop-blur-md">
      <Wrap className="flex items-center gap-6 py-3 max-[901px]:h-14 max-[901px]:gap-3 max-[901px]:py-0">
        <Link href="/" className="flex shrink-0 items-baseline gap-2 max-[901px]:py-2.5">
          <span className="mono text-[15px] font-semibold tracking-tight text-ink">
            <span className="text-phosphor">&gt;_</span> KESTREL
          </span>
          <span className="mono text-[11px] text-ink-meta max-[360px]:hidden">$KEST</span>
        </Link>
        <HeaderNav items={NAV.slice(1)} />
        <HeaderTail />
        <MobileNav items={NAV} />
      </Wrap>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 max-[601px]:mt-16">
      <Rule strong />
      {/* <=900px: tagline full width, Product + Machine surfaces side by side; bottom padding clears the iOS home bar. */}
      <Wrap className="pb-10 pt-14 max-[901px]:pb-[calc(2.5rem+env(safe-area-inset-bottom))] max-[901px]:pt-10">
        <div className="grid grid-cols-12 gap-x-6 gap-y-10 max-[901px]:gap-x-4">
          <div className="col-span-6 min-w-0 max-[901px]:col-span-12">
            <SplitWords as="p" parts={["Stay asleep.", { em: "Kestrel" }, "watches\u00a0the\u00a0chain."]} className="max-w-[16ch] font-serif text-[32px] leading-[1.1] text-ink [text-wrap:balance] max-[601px]:text-[28px]" />
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-ink-2">
              Non-custodial overnight risk, liquidity, bridge-parity and tranche-escrow sentinel for Base (8453) and Robinhood Chain (4663). Not financial advice.
            </p>
          </div>
          <nav aria-label="Product" className="col-span-3 min-w-0 max-[901px]:col-span-6">
            <Kicker>Product</Kicker>
            <ul className="mt-4 space-y-1.5 text-[14px] max-[901px]:space-y-0">
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link href={n.href} className="ink-target max-[901px]:py-0">
                    <span className="ink-line">{n.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Machine surfaces" className="col-span-3 min-w-0 max-[901px]:col-span-6">
            <Kicker>Machine surfaces</Kicker>
            <ul className="mt-4 space-y-1.5 mono text-[13px] max-[901px]:space-y-0 max-[901px]:[overflow-wrap:anywhere]">
              <li><a href="/llms.txt" className="ink-target"><span className="ink-line">/llms.txt</span></a></li>
              <li><a href="/api/openapi.json" className="ink-target"><span className="ink-line">/api/openapi.json</span></a></li>
              <li><Link href="/agents#guard" className="ink-target"><span className="ink-line">/api/v1/guard</span></Link></li>
              <li><Link href="/agents#mcp" className="ink-target"><span className="ink-line">/api/mcp</span></Link></li>
              <li>
                <a href="https://app.vibestarter.xyz" target="_blank" rel="noreferrer" className="ink-target">
                  <span className="ink-line">Vibestarter</span>
                  <span className="text-ink-3">&nbsp;↗</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="mt-12 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-hair pt-5">
          <p className="t-meta max-w-[72ch]">
            Set in Instrument Serif, Inter &amp; JetBrains Mono. Every figure read live from Base 8453 and Robinhood 4663.
          </p>
          <p className="t-meta">
            <span className="text-phosphor">&gt;_</span> KESTREL · $KEST
          </p>
        </div>
      </Wrap>
    </footer>
  );
}
