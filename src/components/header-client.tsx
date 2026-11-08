"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };

/** Pages with no /llms.txt + LAUNCH APP in the header: the landing (its hero carries LAUNCH APP) and the app itself. */
export function hidesHeaderTail(pathname: string): boolean {
  return pathname === "/" || pathname === "/app" || pathname.startsWith("/app/") || pathname === "/rescue" || pathname.startsWith("/rescue/");
}

/** Header menu. Where the header has no CTA (landing, app) it sits flush right. */
export function HeaderNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className={`hidden items-center gap-5 min-[901px]:flex ${hidesHeaderTail(pathname) ? "ml-auto" : ""}`}>
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

/** /llms.txt link + LAUNCH APP button, shown everywhere except the landing page and inside the app. Desktop only (>=901px): on smaller
 *  screens LAUNCH APP lives at the bottom of the mobile drawer and /llms.txt stays in the footer. */
export function HeaderTail() {
  const pathname = usePathname();
  if (hidesHeaderTail(pathname)) return null;
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
