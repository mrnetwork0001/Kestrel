import Link from "next/link";

const NAV = [
  { href: "/app", label: "App" },
  { href: "/rescue", label: "Panic Bunker" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/agents", label: "Agents · x402 · MCP" },
  { href: "/token", label: "$KEST" },
];

export function SiteHeader() {
  return (
    <header className="border-b hairline">
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="mono text-[15px] font-semibold tracking-tight text-ink">
            <span className="text-phosphor">&gt;_</span> KESTREL
          </span>
          <span className="mono text-[11px] text-ink-3">$KEST</span>
        </Link>
        <nav className="hidden items-center gap-5 md:flex">
          {NAV.slice(1).map((n) => (
            <Link key={n.href} href={n.href} className="text-[13px] text-ink-2 transition-colors hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>
        <a href="/llms.txt" className="ml-auto hidden mono text-[11px] text-ink-3 hover:text-phosphor sm:inline">
          /llms.txt
        </a>
        <Link href="/app" className="rounded-[2px] bg-phosphor px-3 py-1.5 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698]">
          LAUNCH APP →
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t hairline">
      <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-10 md:grid-cols-4">
        <div className="md:col-span-2">
          <p className="font-serif text-2xl text-ink">Stay asleep. Kestrel watches the chain.</p>
          <p className="mt-2 max-w-md text-[13px] text-ink-3">
            Non-custodial overnight risk, liquidity, bridge-parity and tranche-escrow sentinel for Base (8453) and Robinhood Chain (4663).
            Every number on this site is read live from mainnet RPCs or Vibestarter&apos;s public API. Not financial advice.
          </p>
        </div>
        <div>
          <p className="label mb-3">Product</p>
          <ul className="space-y-1.5 text-[13px] text-ink-2">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="hover:text-ink">{n.label}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="label mb-3">Machine surfaces</p>
          <ul className="space-y-1.5 mono text-[12px] text-ink-2">
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
