"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const SEL = "[data-rv]:not([data-in])";

/**
 * The one site-wide reveal driver (mounted once in layout). Marks [data-rv] elements with data-in when they enter the
 * viewport. No per-frame loop: one IntersectionObserver + one rAF-throttled MutationObserver (Suspense streaming,
 * tab switches). Does nothing unless the pre-paint script set <html class="js"> (it never does under reduced motion).
 */
export function RevealObserver(): null {
  const pathname = usePathname();

  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains("js") || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.setAttribute("data-in", "");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0 }
    );

    const scan = () => {
      const limit = window.innerHeight * 0.92;
      for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
        const top = el.getBoundingClientRect().top;
        // Already on screen (or scrolled past): reveal now, in the same tick, so nothing visible blinks out.
        if (top < limit) el.setAttribute("data-in", "");
        else io.observe(el);
      }
    };

    // Hash deep links: everything above and inside the target is shown immediately.
    if (location.hash) {
      let target: Element | null = null;
      try {
        target = document.querySelector(decodeURIComponent(location.hash));
      } catch {
        target = null;
      }
      if (target) {
        const bottom = target.getBoundingClientRect().bottom;
        for (const el of document.querySelectorAll(SEL)) {
          if (target.contains(el) || el.getBoundingClientRect().top <= bottom) el.setAttribute("data-in", "");
        }
      }
    }

    scan();

    let raf = 0;
    const mo = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scan();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pathname]);

  return null;
}
