"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
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

export function Workspace({ initialScan, initialTarget, initialChainId, initialTab }: { initialScan: ScanResult | null; initialTarget: string; initialChainId: number; initialTab: TabKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const [target, setTarget] = useState(initialTarget);
  const [chainId, setChainId] = useState(initialChainId);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [input, setInput] = useState(initialTarget);
  const [inputChain, setInputChain] = useState(initialChainId);
  const [inputError, setInputError] = useState<string | null>(null);
  const scan = useScan(target, chainId, initialScan);

  useEffect(() => {
    const q = new URLSearchParams({ target, chain: String(chainId), tab });
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [target, chainId, tab, pathname, router]);

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
    if (tab === "parity" || tab === "shield" || tab === "pager") setTab("briefing");
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-8">
      {/* Omnibar */}
      <form onSubmit={onSubmit} className="panel flex flex-col gap-2 p-2 md:flex-row md:items-stretch">
        <div className="flex shrink-0 overflow-hidden rounded-[2px] border hairline mono text-[11px]">
          {[8453, 4663].map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setInputChain(c)}
              className={cx("px-3 py-2 tracking-wider transition-colors", inputChain === c ? (c === 4663 ? "bg-rh/15 text-rh" : "bg-base/15 text-base") : "text-ink-3 hover:text-ink")}
            >
              {c === 4663 ? "ROBINHOOD 4663" : "BASE 8453"}
            </button>
          ))}
        </div>
        <label className="flex flex-1 items-center gap-2 px-2">
          <span className="mono text-[13px] text-phosphor">&gt;_</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste any wallet, token, pool or Vibestarter escrow address…"
            spellCheck={false}
            className="w-full bg-transparent py-2 mono text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
            aria-label="Target address"
          />
        </label>
        <button type="submit" className="rounded-[2px] bg-phosphor px-5 py-2 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698]">
          {scan.isFetching ? "SCANNING…" : "RUN SCAN"}
        </button>
      </form>
      {inputError && <p className="mt-2 mono text-[12px] text-crit">{inputError}</p>}

      {/* Presets */}
      <div className="mt-3 flex flex-wrap gap-2">
        {LIVE_DEMO_PRESETS.map((p) => {
          const active = p.targetAddress.toLowerCase() === target.toLowerCase() && p.chainId === chainId;
          return (
            <button
              key={p.id}
              onClick={() => {
                load(p.targetAddress, p.chainId);
                setTab(p.kind === "escrow" ? "shield" : p.kind === "pool" ? "chaos" : "briefing");
              }}
              className={cx("flex items-center gap-2 rounded-[2px] border px-2.5 py-1.5 text-[12px] transition-colors", active ? "border-phosphor/50 bg-phosphor/[0.06] text-ink" : "hairline text-ink-2 hover:border-hair-strong hover:text-ink")}
            >
              <ChainBadge chainId={p.chainId} />
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <nav className="mt-6 flex gap-px overflow-x-auto border hairline bg-white/[0.06]" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cx("flex min-w-fit flex-1 items-baseline gap-2 px-4 py-3 text-left transition-colors", tab === t.key ? "bg-elevated text-ink shadow-[inset_0_-2px_0_var(--accent-phosphor)]" : "bg-surface text-ink-3 hover:text-ink")}
          >
            <span className="mono text-[10px]">{t.n}</span>
            <span className="text-[13px]">{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {tab === "briefing" && <BriefingTab scan={scan.data ?? null} loading={scan.isFetching} error={scan.error?.message ?? null} onScan={load} />}
        {tab === "chaos" && <ChaosLabTab scan={scan.data ?? null} />}
        {tab === "parity" && <ParityTab />}
        {tab === "shield" && <BackerShieldTab focus={scan.data?.escrow?.address ?? null} />}
        {tab === "bunker" && <PanicBunkerTab />}
        {tab === "pager" && <PagerTab target={target} chainId={chainId} />}
      </div>
    </div>
  );
}
