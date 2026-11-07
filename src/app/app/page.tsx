import type { Metadata } from "next";
import { cache } from "react";
import { LIVE_DEMO_PRESETS } from "@/config/contracts";
import { Workspace, type TabKey } from "@/components/app/workspace";
import { parseAddress, parseChainId } from "@/lib/engine/chain-utils";
import { cachedScan } from "@/lib/engine/scan";
import type { ChainId } from "@/lib/engine/types";
import { chainName, shortAddr } from "@/lib/format";
import type { Address } from "viem";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const BASE_META: Metadata = {
  title: "Sentinel Workspace",
  description: "Live overnight threat scan, rug simulator, Base ↔ Robinhood parity radar, Vibestarter Backer Shield, Panic Bunker and Night-Shift Pager.",
  alternates: { canonical: "/app" },
};

/**
 * Request-scoped dedupe (generateMetadata + page share one call) on top of the shared 30s KV cache. cachedScan uses
 * /api/scan's key, so SSR and the client's own /api/scan fetch reuse one fan-out, and it never stores a degraded scan
 * (a degraded result is still rendered, with its "incomplete" banner, and the client re-checks on its own fetch).
 */
const scanOnce = cache((chainId: ChainId, target: Address) =>
  cachedScan(chainId, target, { useLlm: false }).then((r) => r.result, () => null)
);

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const sp = await searchParams;
  const target = parseAddress(typeof sp.target === "string" ? sp.target : undefined);
  if (!target || typeof sp.chain !== "string") return BASE_META;
  const chainId = parseChainId(sp.chain, null);
  if (!chainId) return BASE_META;
  const card = `/api/card?target=${target}&chain=${chainId}`;
  const scan = await scanOnce(chainId, target);
  const title = scan ? `${scan.target.label || shortAddr(target)} · ${scan.band} ${scan.score}/100` : `${shortAddr(target)} on ${chainName(chainId)}`;
  const rank = { critical: 2, warn: 1, info: 0 } as const;
  const lead = scan?.findings.reduce<(typeof scan.findings)[number] | null>((m, f) => (!m || rank[f.severity] > rank[m.severity] || (rank[f.severity] === rank[m.severity] && f.points > m.points) ? f : m), null);
  const description = scan
    ? `Live Kestrel threat scan on ${chainName(chainId)} at block #${BigInt(scan.block.number).toLocaleString("en-US")}: ${scan.findings.length} findings${lead ? `, led by "${lead.title}"` : ""}.`
    : `Live Kestrel overnight threat scan for ${target} on ${chainName(chainId)}.`;
  const images = [{ url: card, width: 1200, height: 630, alt: `Kestrel threat card: ${title}` }];
  return {
    title,
    description,
    alternates: { canonical: "/app" },
    openGraph: { title: `Kestrel · ${title}`, description, type: "website", images },
    twitter: { card: "summary_large_image", title: `Kestrel · ${title}`, description, images },
  };
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TABS: TabKey[] = ["briefing", "chaos", "parity", "shield", "bunker", "pager"];

export default async function AppPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const preset = LIVE_DEMO_PRESETS[0];
  const target = parseAddress(typeof sp.target === "string" ? sp.target : undefined) ?? preset.targetAddress;
  const rawChain = typeof sp.chain === "string" ? sp.chain : undefined;
  const parsedChain = parseChainId(rawChain, preset.chainId);
  // An unsupported chain (e.g. ?chain=1) is shown as such; it is never silently swapped for Base data.
  const unsupportedChain = parsedChain ? null : (rawChain ?? "").slice(0, 24);
  const chainId: ChainId = parsedChain ?? preset.chainId;
  const tab = TABS.includes(sp.tab as TabKey) ? (sp.tab as TabKey) : "briefing";
  const escrow = parseAddress(typeof sp.escrow === "string" ? sp.escrow : undefined);
  // SSR the first scan so the workspace paints live telemetry immediately (deterministic brief; LLM brief loads client-side).
  const initial = unsupportedChain ? null : await scanOnce(chainId, target);
  return <Workspace initialScan={initial} initialTarget={target} initialChainId={chainId} initialTab={tab} initialEscrow={escrow} unsupportedChain={unsupportedChain} />;
}
