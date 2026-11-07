import Link from "next/link";
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
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-4 py-3 max-[901px]:h-14 max-[901px]:gap-3 max-[901px]:py-0">
        <Link href="/" className="flex shrink-0 items-baseline gap-2 max-[901px]:py-2.5">
          <span className="mono text-[15px] font-semibold tracking-tight text-ink">
            <span className="text-phosphor">&gt;_</span> KESTREL
          </span>
          <span className="mono text-[11px] text-ink-3 max-[360px]:hidden">$KEST</span>
        </Link>
        <HeaderNav items={NAV.slice(1)} />
        <HeaderTail />
        <MobileNav items={NAV} />
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t hairline max-[601px]:mt-16">
      {/* <=900px: tagline full width, Product + Machine surfaces side by side; bottom padding clears the iOS home bar. */}
      <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-10 min-[901px]:grid-cols-4 max-[901px]:grid-cols-2 max-[901px]:gap-x-4 max-[901px]:gap-y-6 max-[901px]:pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
        <div className="md:col-span-2 max-[901px]:col-span-2">
          <p className="font-serif text-2xl text-ink">Stay asleep. Kestrel watches the chain.</p>
          <p className="mt-2 max-w-md text-[13px] text-ink-3">
            Non-custodial overnight risk, liquidity, bridge-parity and tranche-escrow sentinel for Base (8453) and Robinhood Chain (4663).
            Every number on this site is read live from mainnet RPCs or Vibestarter&apos;s public API. Not financial advice.
          </p>
        </div>
        <div>
          <p className="label mb-3">Product</p>
          <ul className="space-y-1.5 text-[13px] text-ink-2 max-[901px]:space-y-0">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="hover:text-ink max-[901px]:inline-block max-[901px]:py-2">{n.label}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="label mb-3">Machine surfaces</p>
          <ul className="space-y-1.5 mono text-[12px] text-ink-2 max-[901px]:space-y-0 max-[901px]:[&_a]:inline-block max-[901px]:[&_a]:py-2 max-[901px]:[overflow-wrap:anywhere]">
            <li><a href="/llms.txt" className="hover:text-ink">/llms.txt</a></li>
            <li><a href="/api/openapi.json" className="hover:text-ink">/api/openapi.json</a></li>
            <li><Link href="/agents" className="hover:text-ink">/api/v1/guard</Link></li>
            <li><Link href="/agents" className="hover:text-ink">/api/mcp</Link></li>
            <li><a href="https://app.vibestarter.xyz" target="_blank" rel="noreferrer" className="hover:text-ink">Vibestarter ↗</a></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
