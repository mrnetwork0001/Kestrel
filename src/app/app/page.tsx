import type { Metadata } from "next";
import { LIVE_DEMO_PRESETS } from "@/config/contracts";
import { Workspace, type TabKey } from "@/components/app/workspace";
import { normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";

export const metadata: Metadata = {
  title: "Sentinel Workspace",
  description: "Live overnight threat scan, rug simulator, Base ↔ Robinhood parity radar, Vibestarter Backer Shield, Panic Bunker and Night-Shift Pager.",
};

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TABS: TabKey[] = ["briefing", "chaos", "parity", "shield", "bunker", "pager"];

export default async function AppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const preset = LIVE_DEMO_PRESETS[0];
  const target = parseAddress(typeof sp.target === "string" ? sp.target : undefined) ?? preset.targetAddress;
  const chainId = normalizeChainId(typeof sp.chain === "string" ? sp.chain : preset.chainId);
  const tab = TABS.includes(sp.tab as TabKey) ? (sp.tab as TabKey) : "briefing";
  // SSR the first scan so the workspace paints live telemetry immediately (deterministic brief; LLM brief loads client-side).
  const initial = await scanTarget(chainId, target, { useLlm: false }).catch(() => null);
  return <Workspace initialScan={initial} initialTarget={target} initialChainId={chainId} initialTab={tab} />;
}
