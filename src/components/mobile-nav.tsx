"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogoMark } from "./logo-mark";
import { Led } from "./motion/led";

type NavItem = { href: string; label: string };

const DRAWER_ID = "kestrel-mobile-nav";

/**
 * <=900px chrome: the always-visible PANIC BUNKER danger action + a burger that opens a left drawer with the site nav.
 * The drawer is portalled to <body> because the sticky header uses backdrop-filter, which would otherwise become the
 * containing block for `position: fixed` and clip the drawer to the header's height. Hidden entirely at >=901px.
 */
export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const inApp = pathname === "/app" || pathname.startsWith("/app/") || pathname === "/rescue" || pathname.startsWith("/rescue/");
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => setMounted(true), []);

  // Close after any navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close if the viewport grows into the desktop layout while the drawer is open.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const onChange = () => mq.matches && setOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Scroll lock, Esc, focus in on open and back to the burger on close, Tab trapped inside the drawer.
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) burgerRef.current?.focus({ preventScroll: true });
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    // Lock the root, not body: html has overflow-x:hidden at <=900px, so body's overflow no longer
    // propagates to the viewport, and locking body would also re-anchor the sticky bars to body.
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab" || !drawerRef.current) return;
      const focusables = drawerRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!drawerRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="ml-auto flex items-center gap-2 min-[901px]:hidden">
      <Link
        href="/rescue"
        className="press inline-flex h-11 items-center gap-2 rounded-[2px] border border-crit/60 bg-crit/10 px-3 mono text-[11px] font-semibold tracking-[0.06em] text-crit hover:bg-crit/20"
      >
        <Led tone="crit" />
        PANIC BUNKER
      </Link>
      <button
        ref={burgerRef}
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls={DRAWER_ID}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-[4.5px] rounded-[2px] border border-hair-strong bg-surface text-ink"
      >
        <span className={`block h-[1.5px] w-4 bg-current transition-[translate,rotate,opacity] duration-200 ${open ? "translate-y-[6px] rotate-45" : ""}`} />
        <span className={`block h-[1.5px] w-4 bg-current transition-opacity duration-200 ${open ? "opacity-0" : ""}`} />
        <span className={`block h-[1.5px] w-4 bg-current transition-[translate,rotate,opacity] duration-200 ${open ? "-translate-y-[6px] -rotate-45" : ""}`} />
      </button>

      {mounted &&
        createPortal(
          <div className="min-[901px]:hidden">
            <div
              aria-hidden
              onClick={close}
              className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
            />
            <div
              ref={drawerRef}
              id={DRAWER_ID}
              role="dialog"
              aria-modal="true"
              aria-label="Site menu"
              inert={!open}
              className={`fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(88vw,320px)] flex-col border-r hairline bg-surface pb-[env(safe-area-inset-bottom)] duration-[250ms] ease-[cubic-bezier(.2,.7,.2,1)] ${
                // visibility flips instantly on open (so focus can land inside) and only after the slide-out on close
                open ? "visible translate-x-0 shadow-[20px_0_60px_rgba(0,0,0,0.5)] transition-[translate]" : "invisible -translate-x-full transition-[translate,visibility]"
              }`}
            >
              <div className="flex h-14 shrink-0 items-center justify-between border-b hairline px-4">
                <Link href="/" onClick={close} className="flex items-center gap-2">
                  <LogoMark size={20} />
                  <span className="mono text-[15px] font-semibold tracking-tight text-ink">KESTREL</span>
                </Link>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={close}
                  aria-label="Close menu"
                  className="inline-flex h-10 items-center gap-1.5 rounded-[2px] border border-hair-strong px-3 mono text-[11px] text-ink-2 hover:text-ink"
                >
                  <span aria-hidden className="text-[15px] leading-none">&times;</span> CLOSE
                </button>
              </div>
              <nav aria-label="Site" className="flex-1 overflow-y-auto overscroll-contain px-2 py-3">
                <p className="t-kicker px-3 pb-2">Navigate</p>
                <ul>
                  {items.map((n) => {
                    const active = isActive(n.href);
                    const danger = n.href === "/rescue";
                    return (
                      <li key={n.href}>
                        <Link
                          href={n.href}
                          onClick={close}
                          aria-current={active ? "page" : undefined}
                          className={`flex min-h-12 items-center justify-between rounded-[2px] border-l-2 px-3 text-[15px] transition-colors ${
                            active ? "border-phosphor bg-elevated text-ink" : "border-transparent text-ink-2 hover:bg-elevated hover:text-ink"
                          }`}
                        >
                          <span className={danger ? "text-crit" : undefined}>{n.label}</span>
                          <span aria-hidden className="mono text-[12px] text-ink-meta">
                            {n.href}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>
              {inApp ? null : (
              <div className="shrink-0 border-t hairline p-4">
                <Link
                  href="/app"
                  onClick={close}
                  className="flex min-h-12 w-full items-center justify-center rounded-[2px] bg-phosphor mono text-[13px] font-semibold tracking-[0.04em] text-canvas hover:bg-[#a6e698]"
                >
                  LAUNCH APP
                </Link>
              </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
