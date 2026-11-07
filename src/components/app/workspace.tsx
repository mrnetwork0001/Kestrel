"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { isAddress } from "viem";
import { LIVE_DEMO_PRESETS } from "@/config/contracts";
import type { ScanResult } from "@/lib/engine/types";
import { BackerShieldTab } from "./backer-shield-tab";
import { BriefingTab } from "./briefing-tab";
import { ChaosLabTab } from "./chaos-lab-tab";
import { PagerTab } from "./pager-tab";
import { PanicBunkerTab } from "./panic-bunker-tab";
import { ParityTab } from "./parity-tab";
import { CommandRow, type Preset } from "./shell/command-row";
import { DeskTabs, type TabKey } from "./shell/desk-tabs";
import { TargetMasthead, type BriefState } from "./shell/target-masthead";
import { ApiError, briefQuery, scanIncomplete, useBrief, useScan } from "./use-api";

export type { TabKey };

/** Deep-link params other desk sections read on load (Challenge Co-pilot `dryrun`, pager `from`); kept by the URL sync. */
const KEEP_PARAMS = ["dryrun", "from"] as const;

const presetTab = (p: Preset): TabKey => (p.kind === "escrow" ? "shield" : p.kind === "pool" ? "chaos" : "briefing");

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

export function Workspace({
  initialScan,
  initialTarget,
  initialChainId,
  initialTab,
  initialEscrow = null,
  unsupportedChain = null,
}: {
  initialScan: ScanResult | null;
  initialTarget: string;
  initialChainId: number;
  initialTab: TabKey;
  /** `escrow=` deep link (pager / Co-pilot): focuses that escrow in Backer Shield until another target is loaded. */
  initialEscrow?: string | null;
  /** Raw `chain=` value that is neither Base nor Robinhood Chain: no scan runs until the user picks a target. */
  unsupportedChain?: string | null;
}) {
  const pathname = usePathname();
  const qc = useQueryClient();
  const [target, setTarget] = useState(initialTarget);
  const [chainId, setChainId] = useState(initialChainId);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [input, setInput] = useState(initialTarget);
  const [inputChain, setInputChain] = useState(initialChainId);
  const [inputError, setInputError] = useState<string | null>(null);
  const [escrow, setEscrow] = useState<string | null>(initialEscrow);
  const [unsupported, setUnsupported] = useState<string | null>(unsupportedChain);
  const scan = useScan(target, chainId, initialScan, !unsupported);
  const brief = useBrief(target, chainId, false);

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
    const row = tabsRef.current?.closest<HTMLElement>("[data-desk-tabs]");
    const content = contentRef.current;
    if (!row || !content || getComputedStyle(row).position !== "sticky") return;
    const rowBottom = row.getBoundingClientRect().bottom;
    const contentTop = content.getBoundingClientRect().top;
    if (contentTop < rowBottom) window.scrollBy({ top: contentTop - rowBottom - 12 });
  };

  /** Query for a desk URL: target/chain/tab plus a live `escrow=` focus. */
  const deskQuery = useCallback(
    (k: TabKey) => {
      const q = new URLSearchParams({ target, chain: String(chainId), tab: k });
      if (escrow) q.set("escrow", escrow);
      return q;
    },
    [target, chainId, escrow]
  );

  // Shallow URL sync: native replaceState (Next applies it as an ACTION_RESTORE that keeps the current tree and cache,
  // so no server round trip) instead of router.replace, which re-ran the /app server component and scanned the target
  // a second time on top of the client's own /api/scan. Keeps deep-link params (dryrun, from) and the #desk= hash.
  useEffect(() => {
    // Only while the workspace route is current: during a navigation away (e.g. the header logo -> "/"), pathname
    // updates before unmount, and syncing then would rewrite the destination URL.
    if (pathname !== "/app") return;
    const cur = new URLSearchParams(window.location.search);
    const q = deskQuery(tab);
    for (const k of KEEP_PARAMS) {
      const v = cur.get(k);
      if (v != null) q.set(k, v);
    }
    const next = `${pathname}?${q.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(window.history.state, "", next + window.location.hash);
  }, [deskQuery, tab, pathname]);

  const load = (addr: string, cid: number) => {
    setInput(addr);
    setInputChain(cid);
    setTarget(addr);
    setChainId(cid);
    setEscrow(null);
    setUnsupported(null);
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
    // Parity and Backer Shield do not follow the target; the pager stays put so "watch current target" is one step.
    if (tab === "parity" || tab === "shield") selectTab("briefing");
  };

  const onPreset = (p: Preset) => {
    setInputError(null);
    load(p.targetAddress, p.chainId);
    selectTab(presetTab(p));
  };

  const onBrief = () => {
    selectTab("briefing");
    qc.fetchQuery(briefQuery(target, chainId)).catch(() => undefined);
  };

  const data = unsupported ? null : (scan.data ?? null);
  const scanError = unsupported ? null : (scan.error?.message ?? null);
  const briefState: BriefState = brief.isFetching ? "loading" : brief.data ? "loaded" : brief.isError ? "error" : "idle";
  const unsupportedNotice = unsupported ? (
    <>
      Unsupported chain <span className="text-ink">&ldquo;{unsupported}&rdquo;</span>. Kestrel reads Base 8453 or Robinhood Chain 4663 only, so nothing was scanned.
    </>
  ) : null;

  return (
    <div className="pb-16 max-[601px]:pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
      <div className="wrap pt-8 max-[901px]:pt-4">
        <CommandRow
          input={input}
          inputChain={inputChain}
          inputError={inputError}
          scanning={scan.isFetching}
          target={target}
          chainId={chainId}
          onInput={setInput}
          onInputChain={setInputChain}
          onSubmit={onSubmit}
          onPreset={onPreset}
        />
      </div>

      <div className="mt-6 max-[901px]:mt-4">
        <TargetMasthead
          scan={data}
          target={target}
          chainId={chainId}
          loading={!unsupported && scan.isFetching}
          error={scanError}
          retryAfterSec={scan.error instanceof ApiError ? scan.error.retryAfterSec : null}
          degraded={data ? scanIncomplete(data) : []}
          notice={unsupportedNotice}
          onRetry={() => void scan.refetch()}
          onBrief={data ? onBrief : undefined}
          briefState={briefState}
        />
      </div>

      <div className="wrap">
        <DeskTabs
          tab={tab}
          hrefFor={(k) => `/app?${deskQuery(k).toString()}`}
          onSelect={selectTab}
          navRef={tabsRef}
          onScroll={syncFade}
          fade={fade}
          stickyTop={tabsTop}
          bunkerAlert
        />

        <div ref={contentRef} id="desk-panel" role="tabpanel" aria-labelledby={`desk-tab-${tab}`} className="mt-8 min-w-0 max-[901px]:mt-5">
          {/* Keyed: each tab enters with a short rise (CSS only; static under reduced motion). */}
          <div key={tab} className="tab-enter min-w-0">
            {unsupported && (tab === "briefing" || tab === "chaos" || tab === "bunker") ? (
              <div className="border-t border-hair-strong pt-6">
                <p className="max-w-[720px] font-serif text-[22px] leading-[1.25] text-ink">Pick a Base or Robinhood Chain target to start a live scan.</p>
                <p className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                  {LIVE_DEMO_PRESETS.map((p) => (
                    <button key={p.id} type="button" onClick={() => onPreset(p)} className="dot-link press inline-flex min-h-11 items-center gap-2 text-[14px]">
                      <span aria-hidden className={p.chainId === 4663 ? "dot h-1.5 w-1.5 rounded-full bg-rh" : "dot h-1.5 w-1.5 rounded-full bg-base"} />
                      <span className="ink-line">{p.label}</span>
                    </button>
                  ))}
                </p>
              </div>
            ) : (
              <>
                {tab === "briefing" && <BriefingTab scan={data} loading={scan.isFetching} error={scanError} onScan={load} />}
                {tab === "chaos" && <ChaosLabTab scan={data} />}
                {tab === "parity" && <ParityTab />}
                {tab === "shield" && <BackerShieldTab focus={escrow ?? data?.escrow?.address ?? null} />}
                {tab === "bunker" && <PanicBunkerTab target={target} chainId={chainId} scan={data} />}
                {tab === "pager" && <PagerTab target={target} chainId={chainId} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
