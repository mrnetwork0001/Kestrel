"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

/** Header menu. On the landing page it sits flush right (no CTA there — the hero carries LAUNCH APP). */
export function HeaderNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className={`hidden items-center gap-5 min-[901px]:flex ${pathname === "/" ? "ml-auto" : ""}`}>
      {items.map((n) => {
        const active = pathname === n.href || pathname.startsWith(n.href + "/");
        return (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={`ink-target text-[13px] ${active ? "!text-ink" : ""}`}>
            <span className="ink-line">{n.label}</span>
          </Link>
        );
      })}
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
      <a href="/llms.txt" className="ml-auto hidden mono text-[12px] text-ink-meta transition-colors duration-200 hover:text-phosphor min-[901px]:inline">
        /llms.txt
      </a>
      <Link href="/app" className="press hidden rounded-[2px] bg-phosphor px-3.5 py-2 mono text-[12px] font-semibold tracking-[0.04em] text-canvas transition-colors duration-200 hover:bg-[#a6e698] min-[901px]:inline">
        LAUNCH APP
      </Link>
    </>
  );
}
