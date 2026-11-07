"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { isAddress } from "viem";
import { LIVE_DEMO_PRESETS } from "@/config/contracts";
import { ChainBadge, cx } from "@/components/ui";
import type { ScanResult } from "@/lib/engine/types";
import { BackerShieldTab } from "./backer-shield-tab";
import { BriefingTab } from "./briefing-tab";
import { ChaosLabTab } from "./chaos-lab-tab";
import { PagerTab } from "./pager-tab";
import { PanicBunkerTab } from "./panic-bunker-tab";
import { ParityTab } from "./parity-tab";
import { useScan } from "./use-api";

export type TabKey = "briefing" | "chaos" | "parity" | "shield" | "bunker" | "pager";

const TABS: { key: TabKey; n: string; label: string }[] = [
  { key: "briefing", n: "01", label: "Briefing & X-Ray" },
  { key: "chaos", n: "02", label: "Simulate the Rug" },
  { key: "parity", n: "03", label: "Parity Radar" },
  { key: "shield", n: "04", label: "Backer Shield" },
  { key: "bunker", n: "05", label: "Panic Bunker" },
  { key: "pager", n: "06", label: "Night-Shift Pager" },
];

// Run layout reads before paint on the client; plain effect on the server (avoids the SSR useLayoutEffect warning).
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Where the site's top bar ends once pinned: sticky -> its `top` + height, fixed -> its bottom edge, otherwise 0 (the
 * header scrolls away, e.g. on desktop). Measured rather than assumed so the tab row never gaps or hides under it.
 */
function stickyHeaderBottom(): number {
  const header = document.querySelector("body header:not(main header)");
  for (let el: HTMLElement | null = header as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") return Math.max(0, Math.round(el.getBoundingClientRect().bottom));
    if (cs.position === "sticky") return Math.max(0, Math.round((parseFloat(cs.top) || 0) + el.offsetHeight));
  }
  return 0;
}

export function Workspace({ initialScan, initialTarget, initialChainId, initialTab }: { initialScan: ScanResult | null; initialTarget: string; initialChainId: number; initialTab: TabKey }) {
  const pathname = usePathname();
  const [target, setTarget] = useState(initialTarget);
  const [chainId, setChainId] = useState(initialChainId);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [input, setInput] = useState(initialTarget);
  const [inputChain, setInputChain] = useState(initialChainId);
  const [inputError, setInputError] = useState<string | null>(null);
  const scan = useScan(target, chainId, initialScan);

  // Mobile tab row: sticky under the site's top bar, horizontally scrollable, edge fades when more tabs are off-screen.
  const tabsRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [tabsTop, setTabsTop] = useState(0);
  const [fade, setFade] = useState({ left: false, right: false });
  const syncFade = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
  }, []);
  useEffect(() => {
    const measure = () => {
      setTabsTop(stickyHeaderBottom());
      syncFade();
    };
    measure();
    const header = document.querySelector("body header:not(main header)");
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (header) ro?.observe(header);
    if (tabsRef.current) ro?.observe(tabsRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [syncFade]);
  // Keep the active tab in view inside the row (horizontal only: never scrolls the page).
  useIsoLayoutEffect(() => {
    const row = tabsRef.current;
    const btn = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !btn || row.scrollWidth <= row.clientWidth) return;
    const target = btn.offsetLeft - (row.clientWidth - btn.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [tab]);
  const selectTab = (k: TabKey) => {
    setTab(k);
    // If the row is pinned (user scrolled into a long tab), jump to the top of the new tab's content.
    const row = tabsRef.current;
    const content = contentRef.current;
    if (!row || !content || getComputedStyle(row).position !== "sticky") return;
    const rowBottom = row.getBoundingClientRect().bottom;
    const contentTop = content.getBoundingClientRect().top;
    if (contentTop < rowBottom) window.scrollBy({ top: contentTop - rowBottom - 12 });
  };

  // Shallow URL sync: native replaceState (Next applies it as an ACTION_RESTORE that keeps the current tree and cache,
  // so no server round trip) instead of router.replace, which re-ran the /app server component and scanned the target
  // a second time on top of the client's own /api/scan.
  useEffect(() => {
    // Only while the workspace route is current: during a navigation away (e.g. the header logo -> "/"), pathname
    // updates before unmount, and syncing then would rewrite the destination URL.
    if (pathname !== "/app") return;
    const q = new URLSearchParams({ target, chain: String(chainId), tab });
    const next = `${pathname}?${q.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, "", next);
  }, [target, chainId, tab, pathname]);

  const load = (addr: string, cid: number) => {
    setInput(addr);
    setInputChain(cid);
    setTarget(addr);
    setChainId(cid);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    if (!isAddress(v, { strict: false })) {
      setInputError("Enter a valid 0x address (40 hex characters).");
      return;
    }
    setInputError(null);
    load(v, inputChain);
    if (tab === "parity" || tab === "shield" || tab === "pager") selectTab("briefing");
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-8 max-[900px]:pt-4 max-[600px]:px-2.5 max-[600px]:pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
      {/* Omnibar: one row on desktop; ≤900px stacks chain toggle / input / RUN SCAN */}
      <form onSubmit={onSubmit} className="panel flex flex-col gap-2 p-2 min-[901px]:flex-row min-[901px]:items-stretch">
        <div className="flex shrink-0 overflow-hidden rounded-[2px] border hairline mono text-[11px] max-[900px]:grid max-[900px]:grid-cols-2">
          {[8453, 4663].map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setInputChain(c)}
              className={cx("px-3 py-2 tracking-wider transition-colors max-[900px]:min-h-10", inputChain === c ? (c === 4663 ? "bg-rh/15 text-rh" : "bg-base/15 text-base") : "text-ink-3 hover:text-ink")}
            >
              {c === 4663 ? "ROBINHOOD 4663" : "BASE 8453"}
            </button>
          ))}
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <span className="mono text-[13px] text-phosphor">&gt;_</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste any wallet, token, pool or Vibestarter escrow address…"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent py-2 mono text-[13px] text-ink placeholder:text-ink-3 focus:outline-none max-[900px]:text-[16px]"
            aria-label="Target address"
          />
        </label>
        <button type="submit" className="rounded-[2px] bg-phosphor px-5 py-2 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698] max-[900px]:min-h-11">
          {scan.isFetching ? "SCANNING…" : "RUN SCAN"}
        </button>
      </form>
      {inputError && <p className="mt-2 mono text-[12px] text-crit">{inputError}</p>}

      {/* Presets: wrap on desktop; ≤600px one horizontally scrollable, edge-to-edge line (right edge fades) */}
      <div className="mt-3 flex flex-wrap gap-2 max-[600px]:-mx-2.5 max-[600px]:flex-nowrap max-[600px]:overflow-x-auto max-[600px]:pl-2.5 max-[600px]:pr-8 max-[600px]:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] max-[600px]:[scrollbar-width:none] max-[600px]:[&::-webkit-scrollbar]:hidden">
        {LIVE_DEMO_PRESETS.map((p) => {
          const active = p.targetAddress.toLowerCase() === target.toLowerCase() && p.chainId === chainId;
          return (
            <button
              key={p.id}
              onClick={() => {
                load(p.targetAddress, p.chainId);
                setTab(p.kind === "escrow" ? "shield" : p.kind === "pool" ? "chaos" : "briefing");
              }}
              className={cx("flex max-w-full items-center gap-2 rounded-[2px] border px-2.5 py-1.5 text-left text-[12px] transition-colors max-[900px]:min-h-10 max-[600px]:max-w-none max-[600px]:shrink-0 max-[600px]:whitespace-nowrap", active ? "border-phosphor/50 bg-phosphor/[0.06] text-ink" : "hairline text-ink-2 hover:border-hair-strong hover:text-ink")}
            >
              <ChainBadge chainId={p.chainId} className="shrink-0" />
              <span className="text-left">{p.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tabs: ≤900px a sticky, horizontally scrollable segmented row pinned under the top bar */}
      <div className="relative mt-6 max-[900px]:sticky max-[900px]:z-20 max-[900px]:mt-4 max-[900px]:top-[var(--ws-tabs-top)] max-[900px]:bg-canvas/85 max-[900px]:backdrop-blur-md" style={{ "--ws-tabs-top": `${tabsTop}px` } as CSSProperties}>
        <nav
          ref={tabsRef}
          onScroll={syncFade}
          className="flex gap-px overflow-x-auto border hairline bg-white/[0.06] max-[900px]:snap-x max-[900px]:[scrollbar-width:none] max-[900px]:[&::-webkit-scrollbar]:hidden"
          role="tablist"
        >
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => selectTab(t.key)}
              className={cx(
                "flex min-w-fit flex-1 items-baseline gap-2 px-4 py-3 text-left transition-colors max-[900px]:snap-start max-[900px]:whitespace-nowrap max-[600px]:px-3",
                tab === t.key ? "bg-elevated text-ink shadow-[inset_0_-2px_0_var(--accent-phosphor)]" : "bg-surface text-ink-3 hover:text-ink"
              )}
            >
              <span className="mono text-[10px]">{t.n}</span>
              <span className="text-[13px]">{t.label}</span>
            </button>
          ))}
        </nav>
        <span aria-hidden className={cx("pointer-events-none absolute inset-y-px left-px hidden w-8 bg-gradient-to-r from-canvas to-transparent transition-opacity max-[900px]:block", fade.left ? "opacity-100" : "opacity-0")} />
        <span aria-hidden className={cx("pointer-events-none absolute inset-y-px right-px hidden w-10 bg-gradient-to-l from-canvas to-transparent transition-opacity max-[900px]:block", fade.right ? "opacity-100" : "opacity-0")} />
      </div>

      <div ref={contentRef} className="mt-6 max-[900px]:mt-4">
        {tab === "briefing" && <BriefingTab scan={scan.data ?? null} loading={scan.isFetching} error={scan.error?.message ?? null} onScan={load} />}
        {tab === "chaos" && <ChaosLabTab scan={scan.data ?? null} />}
        {tab === "parity" && <ParityTab />}
        {tab === "shield" && <BackerShieldTab focus={scan.data?.escrow?.address ?? null} />}
        {tab === "bunker" && <PanicBunkerTab target={target} chainId={chainId} scan={scan.data ?? null} />}
        {tab === "pager" && <PagerTab target={target} chainId={chainId} />}
      </div>
    </div>
  );
}
