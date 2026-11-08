import Link from "next/link";
import { Kicker, Rule, Wrap } from "./editorial";
import { SplitWords } from "./motion";
import { HeaderNav, HeaderTail } from "./header-client";
import { LogoMark } from "./logo-mark";
import { MobileNav } from "./mobile-nav";

const NAV = [
  { href: "/app", label: "App" },
  { href: "/rescue", label: "Panic Bunker" },
  { href: "/ecosystem", label: "Ecosystem" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/agents", label: "Agents · x402 · MCP" },
];

export function SiteHeader() {
  return (
    // Sticky, blurred top bar at every width (height = --topbar-h): 64px desktop, 56px <=900px (brand | PANIC BUNKER + burger).
    // Tailwind v4 `max-[901px]:` compiles to `width < 901px`, i.e. <=900px, pairing exactly with `min-[901px]:`.
    <header className="sticky top-0 z-30 border-b hairline bg-canvas/85 backdrop-blur-md">
      <Wrap className="wrap-header flex h-16 items-center gap-6 max-[901px]:h-14 max-[901px]:gap-3">
        <Link href="/" className="flex shrink-0 items-center gap-2 max-[901px]:py-2.5">
          <LogoMark size={20} />
          <span className="mono text-[15px] font-semibold tracking-tight text-ink">KESTREL</span>
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
      </Wrap>
    </footer>
  );
}
