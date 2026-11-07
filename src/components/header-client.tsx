"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

/** Header menu. On the landing page it sits flush right (no CTA there — the hero carries LAUNCH APP). */
export function HeaderNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className={`hidden items-center gap-5 min-[901px]:flex ${pathname === "/" ? "ml-auto" : ""}`}>
      {items.map((n) => (
        <Link key={n.href} href={n.href} className="text-[13px] text-ink-2 transition-colors hover:text-ink">
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

/** /llms.txt link + LAUNCH APP button, shown everywhere except the landing page. Desktop only (>=901px): on smaller
 *  screens LAUNCH APP lives at the bottom of the mobile drawer and /llms.txt stays in the footer. */
export function HeaderTail() {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <>
      <a href="/llms.txt" className="ml-auto hidden mono text-[11px] text-ink-3 hover:text-phosphor min-[901px]:inline">
        /llms.txt
      </a>
      <Link href="/app" className="hidden rounded-[2px] bg-phosphor px-3 py-1.5 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698] min-[901px]:inline">
        LAUNCH APP
      </Link>
    </>
  );
}
