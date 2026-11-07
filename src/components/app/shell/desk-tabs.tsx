"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { cx } from "@/components/ui";
import { Led, LiveValue } from "@/components/motion";
import type { Pulse } from "@/lib/engine/pulse-types";

export type TabKey = "briefing" | "chaos" | "parity" | "shield" | "bunker" | "pager";

export const DESK_TABS: { key: TabKey; label: string }[] = [
  { key: "briefing", label: "Briefing" },
  { key: "chaos", label: "Rug Lab" },
  { key: "parity", label: "Parity" },
  { key: "shield", label: "Backer Shield" },
  { key: "bunker", label: "Panic Bunker" },
  { key: "pager", label: "Pager" },
];

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Chain heads from the shared /api/pulse feed (memoised + CDN-cached server-side, so polling is cheap). */
function useChainHeads() {
  return useQuery({
    queryKey: ["pulse-heads"],
    queryFn: async () => {
      const res = await fetch("/api/pulse");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as Pulse;
      const head = (c: Pulse["chains"]["base"] | undefined) => (c?.ok && c.to ? c.to : null);
      return { base: head(p.chains?.base), rh: head(p.chains?.rh) };
    },
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
    staleTime: 4_000,
    retry: 1,
  });
}

function Head({ label, value, tone }: { label: string; value: string | null | undefined; tone: "base" | "rh" }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={tone === "base" ? "text-base" : "text-rh"}>{label}</span>
      <LiveValue value={value ?? ""}>
        <span className="tnum text-ink-2">{value ? `#${BigInt(value).toLocaleString("en-US")}` : "—"}</span>
      </LiveValue>
    </span>
  );
}

/**
 * The desk's section nav: six text tabs (real <a role="tab"> links, so they work with JavaScript off), one sliding
 * phosphor indicator, a crit dot on Panic Bunker and the live chain heads on the right.
 * ≤900px the row is the sticky swipe row pinned under the site's top bar (top + fades are measured by the parent).
 */
export function DeskTabs({
  tab,
  hrefFor,
  onSelect,
  navRef,
  onScroll,
  fade,
  stickyTop,
  bunkerAlert,
}: {
  tab: TabKey;
  hrefFor: (k: TabKey) => string;
  onSelect: (k: TabKey) => void;
  navRef: RefObject<HTMLElement | null>;
  onScroll: () => void;
  fade: { left: boolean; right: boolean };
  stickyTop: number;
  /** Crit dot on Panic Bunker: true when the current scan has something to rescue (or always, as a standing marker). */
  bunkerAlert: boolean;
}) {
  const heads = useChainHeads();
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const tabRefs = useRef<Partial<Record<TabKey, HTMLAnchorElement | null>>>({});

  const measure = useCallback(() => {
    const el = tabRefs.current[tab];
    if (!el) return;
    // The label span, not the padded link: the indicator sits exactly under the words.
    const label = el.querySelector<HTMLElement>("[data-tab-label]") ?? el;
    const x = el.offsetLeft + label.offsetLeft;
    const w = label.offsetWidth;
    setInd((p) => (p && p.x === x && p.w === w ? p : { x, w }));
  }, [tab]);

  useIsoLayoutEffect(measure, [measure]);
  useEffect(() => {
    // Enable the slide only after the first placement, so the indicator never sweeps in from the left on load.
    const r = requestAnimationFrame(() => setAnimate(true));
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (navRef.current) ro?.observe(navRef.current);
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      cancelAnimationFrame(r);
      ro?.disconnect();
    };
  }, [measure, navRef]);

  const click = (k: TabKey) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onSelect(k);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const i = DESK_TABS.findIndex((t) => t.key === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % DESK_TABS.length : e.key === "ArrowLeft" ? (i - 1 + DESK_TABS.length) % DESK_TABS.length : e.key === "Home" ? 0 : e.key === "End" ? DESK_TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const k = DESK_TABS[next].key;
    onSelect(k);
    tabRefs.current[k]?.focus();
  };

  const live = heads.data && (heads.data.base || heads.data.rh);

  return (
    <div
      data-desk-tabs
      className="relative mt-8 border-b border-hair max-[901px]:sticky max-[901px]:z-20 max-[901px]:-mx-[clamp(16px,2.5vw,36px)] max-[901px]:mt-0 max-[901px]:top-[var(--ws-tabs-top)] max-[901px]:bg-canvas/95 max-[901px]:px-[clamp(16px,2.5vw,36px)] max-[901px]:backdrop-blur-md"
      style={{ "--ws-tabs-top": `${stickyTop}px` } as CSSProperties}
    >
      <div className="flex items-end gap-6">
        <nav
          ref={navRef}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          role="tablist"
          aria-label="Desk sections"
          className="relative flex min-w-0 flex-1 gap-8 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[901px]:snap-x max-[901px]:gap-6"
        >
          {DESK_TABS.map((t) => {
            const on = tab === t.key;
            return (
              <a
                key={t.key}
                ref={(el) => {
                  tabRefs.current[t.key] = el;
                }}
                href={hrefFor(t.key)}
                role="tab"
                id={`desk-tab-${t.key}`}
                aria-selected={on}
                aria-controls="desk-panel"
                tabIndex={on ? 0 : -1}
                onClick={click(t.key)}
                className={cx(
                  "relative inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap text-[15px] transition-colors duration-200 max-[901px]:snap-start focus-visible:outline-none focus-visible:[&_[data-tab-label]]:underline focus-visible:[&_[data-tab-label]]:decoration-phosphor focus-visible:[&_[data-tab-label]]:underline-offset-[6px]",
                  on ? "text-ink" : "text-ink-2 hover:text-ink"
                )}
              >
                <span data-tab-label className="relative">
                  {t.label}
                  {/* Pre-hydration / no-JS marker; the sliding indicator replaces it once measured. */}
                  {on && !ind && <span aria-hidden className="absolute inset-x-0 -bottom-[13px] h-[2px] bg-phosphor" />}
                </span>
                {t.key === "bunker" && bunkerAlert && (
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-crit" title="Rescue available" />
                )}
              </a>
            );
          })}
          {ind && (
            <span
              aria-hidden
              className="tab-indicator"
              style={{ transform: `translateX(${ind.x}px) scaleX(${ind.w / 100})`, ...(animate ? {} : { transition: "none" }) }}
            />
          )}
        </nav>

        <p className="mb-3 hidden shrink-0 items-center gap-3 mono text-[12px] text-ink-meta min-[1101px]:flex" aria-live="off">
          <span className="inline-flex items-center gap-2">
            <Led tone={live ? "phosphor" : heads.isError ? "warn" : "idle"} mode="event" eventKey={heads.data?.base ?? heads.data?.rh ?? null} />
            <span className={live ? "text-phosphor" : undefined}>{live ? "LIVE" : heads.isError ? "FEED LOST" : "CONNECTING"}</span>
          </span>
          <span aria-hidden>·</span>
          <Head label="BASE" value={heads.data?.base} tone="base" />
          <span aria-hidden>·</span>
          <Head label="RH" value={heads.data?.rh} tone="rh" />
        </p>
      </div>
      <span aria-hidden className={cx("pointer-events-none absolute inset-y-0 left-0 hidden w-8 bg-gradient-to-r from-canvas to-transparent transition-opacity max-[901px]:block", fade.left ? "opacity-100" : "opacity-0")} />
      <span aria-hidden className={cx("pointer-events-none absolute inset-y-0 right-0 hidden w-10 bg-gradient-to-l from-canvas to-transparent transition-opacity max-[901px]:block", fade.right ? "opacity-100" : "opacity-0")} />
    </div>
  );
}
