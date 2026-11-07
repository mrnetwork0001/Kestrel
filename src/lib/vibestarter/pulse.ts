import { cached } from "@/lib/cache";
import { settle } from "@/lib/rpc";
import { fetchPlatformStatsRest } from "@/lib/engine/vibestarter-api";
import { vibestarterRaiseUrl } from "./addresses";
import { readLockedPositions } from "./lock";
import { getPlatformStatsViaMcp, listRaisesViaMcp, type McpProvenance, type VsNextUnlock, type VsPlatformStats, type VsRaiseSummary } from "./mcp-client";

/**
 * "Vibestarter Pulse": platform-wide figures pulled from Vibestarter's MCP server (get_platform_stats +
 * list_raises), with REST /api/stats as fallback, and Vibestarter's "liquidity locked" figure reconciled
 * against the on-chain sum of VibesLPLockerV2.getAllLockedPositions().ethAmount (matched to the wei on
 * 2026-11-07: 19.0210725 ETH). All values are live; nothing is hard-coded. JSON-safe (wei as strings).
 */
export interface VibestarterPulse {
  source: "mcp" | "rest" | "unavailable";
  provenance: McpProvenance | null;
  asOf: string | null;
  stats: {
    raisedWei: string;
    backers: number;
    inEscrowWei: string;
    inEscrowRaises: number;
    releasedWei: string;
    releasesCount: number;
    liquidityWei: string;
    liquidityRaises: number;
    funded: number;
    listed: number;
    liveCount: number;
    campaignCount: number;
    byChain: Record<string, { raisedWei: string | null; listed: number | null }>;
  } | null;
  nextUnlock: (VsNextUnlock & { vibestarterUrl: string | null; unixAt: number }) | null;
  liquidityReconciliation: {
    vibestarterWei: string;
    onchainWei: string;
    deltaWei: string;
    matches: boolean;
    positions: number;
    locker: string;
    block: string;
    note: string;
  } | null;
  raises: { items: VsRaiseSummary[]; provenance: McpProvenance } | null;
  errors: string[];
  fetchedAt: string;
}

async function buildPulse(): Promise<VibestarterPulse> {
  const errors: string[] = [];
  const [mcpStats, mcpList, lockers] = await Promise.all([
    getPlatformStatsViaMcp().catch((e: unknown) => {
      errors.push(`MCP get_platform_stats: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      return null;
    }),
    listRaisesViaMcp().catch((e: unknown) => {
      errors.push(`MCP list_raises: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      return null;
    }),
    settle(readLockedPositions(8453)),
  ]);

  let source: VibestarterPulse["source"] = "unavailable";
  let s: VsPlatformStats | null = null;
  if (mcpStats?.data?.figures) {
    s = mcpStats.data;
    source = "mcp";
  } else {
    const rest = (await fetchPlatformStatsRest()) as VsPlatformStats | null;
    if (rest?.figures) {
      s = rest;
      source = "rest";
    }
  }

  const f = s?.figures ?? null;
  const stats: VibestarterPulse["stats"] = f
    ? {
        raisedWei: f.raised.wei,
        backers: f.backers.count,
        inEscrowWei: f.inEscrow.wei,
        inEscrowRaises: f.inEscrow.raises,
        releasedWei: f.released.wei,
        releasesCount: f.released.count,
        liquidityWei: f.liquidity.wei,
        liquidityRaises: f.liquidity.raises,
        funded: f.funded,
        listed: f.listed,
        liveCount: f.live?.count ?? 0,
        campaignCount: s?.campaignCount ?? f.listed,
        byChain: Object.fromEntries(Object.entries(f.byChain ?? {}).map(([k, v]) => [k, { raisedWei: v.raised?.wei ?? null, listed: v.listed ?? null }])),
      }
    : null;

  const nu = f?.inEscrow.nextUnlock ?? null;
  const nextUnlock = nu ? { ...nu, vibestarterUrl: vibestarterRaiseUrl(nu.txHash), unixAt: Math.floor(Date.parse(nu.at) / 1000) } : null;

  let liquidityReconciliation: VibestarterPulse["liquidityReconciliation"] = null;
  const v2 = lockers?.[0];
  if (f && v2) {
    const onchain = BigInt(v2.totalEthPaired);
    const theirs = BigInt(f.liquidity.wei);
    const delta = onchain - theirs;
    liquidityReconciliation = {
      vibestarterWei: theirs.toString(),
      onchainWei: onchain.toString(),
      deltaWei: delta.toString(),
      matches: delta === 0n,
      positions: v2.positions.length,
      locker: v2.locker,
      block: v2.block,
      note:
        delta === 0n
          ? `Vibestarter's "liquidity locked" equals the on-chain sum of ${v2.positions.length} VibesLPLockerV2 positions to the wei.`
          : `Vibestarter reports a different figure than the on-chain locker sum (Δ ${delta.toString()} wei); Vibestarter defines it as 15% of effective raised per pooled raise.`,
    };
  }

  return {
    source,
    provenance: source === "mcp" ? (mcpStats?.provenance ?? null) : null,
    asOf: f && "asOf" in f ? (f as { asOf?: string }).asOf ?? null : null,
    stats,
    nextUnlock,
    liquidityReconciliation,
    raises: mcpList?.data && Array.isArray(mcpList.data) ? { items: mcpList.data, provenance: mcpList.provenance } : null,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

/** Landing-page / MCP-tool data function. Never throws; cached 60 s on the shared KV. */
export async function vibestarterPulse(): Promise<VibestarterPulse> {
  try {
    return await cached("vs-pulse:v1", 60, buildPulse);
  } catch (e) {
    return {
      source: "unavailable",
      provenance: null,
      asOf: null,
      stats: null,
      nextUnlock: null,
      liquidityReconciliation: null,
      raises: null,
      errors: [e instanceof Error ? e.message : String(e)],
      fetchedAt: new Date().toISOString(),
    };
  }
}
