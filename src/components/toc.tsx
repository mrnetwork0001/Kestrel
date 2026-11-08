"use client";

import { useEffect, useRef, useState } from "react";

export type TocItem = { id: string; label: string };

/**
 * Sticky table of contents for content pages. Plain anchors (works with JS off); a small IntersectionObserver
 * marks the chapter currently being read. Desktop: vertical list with a 2px phosphor rule on the active item.
 * <=900px: a sticky, horizontally scrolling anchor line under the mobile top bar.
 */
export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const lineRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => Boolean(e));
    if (!els.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = items.find((i) => seen.get(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);

  // Keep the active anchor visible in the mobile scroll line.
  useEffect(() => {
    if (!active || !lineRef.current || window.matchMedia("(min-width: 901px)").matches) return;
    const a = lineRef.current.querySelector<HTMLElement>(`a[href="#${CSS.escape(active)}"]`);
    if (a) lineRef.current.scrollTo({ left: a.offsetLeft - 16, behavior: "smooth" });
  }, [active]);

  return (
    <nav
      aria-label="On this page"
      className="sticky top-[calc(var(--topbar-h)+32px)] max-[901px]:top-14 max-[901px]:z-20 max-[901px]:-mx-[clamp(16px,2.5vw,36px)] max-[901px]:border-b max-[901px]:border-hair max-[901px]:bg-canvas/90 max-[901px]:backdrop-blur-md"
    >
      <p className="t-kicker mb-4 max-[901px]:hidden">On this page</p>
      <ul
        ref={lineRef}
        className="space-y-0.5 max-[901px]:flex max-[901px]:gap-5 max-[901px]:space-y-0 max-[901px]:overflow-x-auto max-[901px]:whitespace-nowrap max-[901px]:px-[clamp(16px,2.5vw,36px)] max-[901px]:[scrollbar-width:none] max-[901px]:[&::-webkit-scrollbar]:hidden"
      >
        {items.map((i) => {
          const on = active === i.id;
          return (
            <li key={i.id} className="shrink-0">
              <a
                href={`#${i.id}`}
                aria-current={on ? "location" : undefined}
                className={`block border-l-2 py-1.5 pl-3 text-[14px] transition-colors duration-200 max-[901px]:flex max-[901px]:min-h-11 max-[901px]:items-center max-[901px]:border-b-2 max-[901px]:border-l-0 max-[901px]:py-0 max-[901px]:pl-0 ${
                  on ? "border-phosphor text-ink" : "border-transparent text-ink-2 hover:text-ink"
                }`}
              >
                {i.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
