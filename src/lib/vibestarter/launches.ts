import { type Address, getAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { cached } from "@/lib/cache";
import { getPublicClientForChain, settle } from "@/lib/rpc";
import { fetchCampaignDetail, fetchCampaigns, probeAppHealthCached, type AppHealth } from "@/lib/engine/vibestarter-api";
import { githubIdFromAvatar, readGithubVelocity, resolveGithubLogin } from "@/lib/engine/github";
import type { ChainId, GithubVelocity, LpLockProof } from "@/lib/engine/types";
import { VS_FACTORY_ABI } from "./abis";
import { VIBESTARTER, vibestarterRaiseUrl } from "./addresses";
import { readLpLock } from "./lock";
import { listRaisesViaMcp, type McpProvenance } from "./mcp-client";

/**
 * The whole Vibestarter launch universe without deep log scans (free RPCs cannot serve history back to
 * the router deploy): getAllEscrows() on every factory (old + current on Base, Robinhood factory),
 * unioned with the public REST list and the Vibestarter MCP `list_raises` tool. Keyed by chainId:escrow.
 */

export type LaunchSource = "factory" | "rest" | "mcp" | "genesis";

export interface VibestarterLaunch {
  key: string;
  chainId: ChainId;
  escrow: string;
  factory: string | null;
  factoryLabel: string | null;
  title: string | null;
  apiStatus: string | null;
  mcpStatus: string | null;
  launchTx: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  totalRaisedWei: string | null;
  contributorCount: number | null;
  vibestarterUrl: string | null;
  sources: LaunchSource[];
}

export interface LaunchUniverse {
  launches: VibestarterLaunch[];
  factories: { chainId: ChainId; address: string; label: string; totalEscrows: number | null }[];
  mcp: { ok: boolean; raises: number | null; provenance: McpProvenance | null; error: string | null };
  restCount: number;
  fetchedAt: string;
}

const GENESIS = CONTRACTS.base.vibesGenesisEscrow.toLowerCase();

async function buildUniverse(): Promise<LaunchUniverse> {
  const map = new Map<string, VibestarterLaunch>();
  const add = (chainId: ChainId, escrow: string, src: LaunchSource, patch: Partial<VibestarterLaunch> = {}) => {
    const key = `${chainId}:${escrow.toLowerCase()}`;
    let cur = map.get(key);
    if (!cur) {
      cur = {
        key,
        chainId,
        escrow: getAddress(escrow),
        factory: null,
        factoryLabel: null,
        title: null,
        apiStatus: null,
        mcpStatus: null,
        launchTx: null,
        tokenAddress: null,
        tokenSymbol: null,
        totalRaisedWei: null,
        contributorCount: null,
        vibestarterUrl: null,
        sources: [],
      };
      map.set(key, cur);
    }
    if (!cur.sources.includes(src)) cur.sources.push(src);
    for (const [k, v] of Object.entries(patch) as [keyof VibestarterLaunch, unknown][]) {
      if (v !== null && v !== undefined && (cur[k] === null || cur[k] === undefined)) (cur as unknown as Record<string, unknown>)[k] = v;
    }
  };

  add(8453, CONTRACTS.base.vibesGenesisEscrow, "genesis", { title: "Vibestarter" });

  const factories: LaunchUniverse["factories"] = [];
  await Promise.all(
    ([8453, 4663] as const).map(async (chainId) => {
      const cfg = VIBESTARTER[chainId];
      const c = getPublicClientForChain(chainId);
      const res = await c
        .multicall({
          allowFailure: true,
          contracts: cfg.factories.flatMap((f) => [
            { address: f.address, abi: VS_FACTORY_ABI, functionName: "getAllEscrows" as const },
            { address: f.address, abi: VS_FACTORY_ABI, functionName: "totalEscrows" as const },
          ]),
        })
        .catch(() => null);
      cfg.factories.forEach((f, i) => {
        const all = res?.[i * 2];
        const total = res?.[i * 2 + 1];
        factories.push({ chainId, address: f.address, label: f.label, totalEscrows: total?.status === "success" ? Number(total.result as bigint) : null });
        if (all?.status === "success") for (const e of all.result as readonly Address[]) add(chainId, e, "factory", { factory: f.address, factoryLabel: f.label });
      });
    })
  );

  const campaigns = await fetchCampaigns();
  for (const c of campaigns) {
    if (!c.escrowAddress || (c.chainId !== 8453 && c.chainId !== 4663)) continue;
    const launchTx = c.token?.launchTxHash ?? null;
    add(c.chainId, c.escrowAddress, "rest", {
      title: c.title,
      apiStatus: c.status,
      launchTx,
      tokenAddress: c.token?.address ? getAddress(c.token.address) : null,
      tokenSymbol: c.token?.symbol ?? null,
      totalRaisedWei: c.totalRaised ?? null,
      contributorCount: c.contributorCount ?? null,
    });
  }

  // MCP list_raises: cross-check + provenance. Its status enum omits REFUNDING/CANCELLED raises.
  let mcp: LaunchUniverse["mcp"] = { ok: false, raises: null, provenance: null, error: null };
  try {
    const r = await listRaisesViaMcp();
    const raises = Array.isArray(r.data) ? r.data : [];
    mcp = { ok: true, raises: raises.length, provenance: r.provenance, error: null };
    const all = [...map.values()];
    for (const raise of raises) {
      const tok = raise.tokenAddress?.toLowerCase() ?? null;
      const target =
        (raise.slug === "vibes" ? all.find((l) => l.escrow.toLowerCase() === GENESIS) : null) ??
        all.find((l) => l.launchTx && l.launchTx.toLowerCase() === raise.slug.toLowerCase()) ??
        (tok ? all.find((l) => l.tokenAddress?.toLowerCase() === tok) : undefined);
      if (target) {
        if (!target.sources.includes("mcp")) target.sources.push("mcp");
        target.mcpStatus = raise.status;
        target.title ??= raise.title;
        target.tokenSymbol ??= raise.tokenSymbol;
      }
    }
  } catch (e) {
    mcp = { ok: false, raises: null, provenance: null, error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }

  const launches = [...map.values()].map((l) => ({
    ...l,
    vibestarterUrl: l.escrow.toLowerCase() === GENESIS ? vibestarterRaiseUrl("vibes") : vibestarterRaiseUrl(l.launchTx),
  }));
  return { launches, factories, mcp, restCount: campaigns.length, fetchedAt: new Date().toISOString() };
}

/** Full launch universe with factory/REST/MCP provenance (cached 60 s). */
export function readLaunchUniverse(): Promise<LaunchUniverse> {
  return cached("vs-launch-universe:v1", 60, buildUniverse);
}

/** Every known Vibestarter launch (escrow) on Base + Robinhood Chain. */
export async function listVibestarterLaunches(): Promise<VibestarterLaunch[]> {
  return (await readLaunchUniverse()).launches;
}

export interface LaunchHealth {
  chainId: ChainId;
  escrow: string;
  title: string | null;
  appUrl: string | null;
  appHealth: AppHealth | null;
  repoUrl: string | null;
  githubLogin: string | null;
  github: GithubVelocity | null;
  lpLock: LpLockProof | null;
  lpLockTxHash: string | null;
  vibestarterUrl: string | null;
  fetchedAt: string;
}

/**
 * Live health of one launch for the Ecosystem board: founder app HTTP probe (60 s cache), founder GitHub
 * velocity (30 min cache) and on-chain Proof-of-Lock. Accepts a `VibestarterLaunch` or `{chainId, escrow}`.
 */
export async function readLaunchHealth(launch: Pick<VibestarterLaunch, "chainId" | "escrow"> & Partial<VibestarterLaunch>): Promise<LaunchHealth> {
  const isGenesis = launch.escrow.toLowerCase() === GENESIS;
  let l: Partial<VibestarterLaunch> = launch;
  if (!isGenesis && !launch.launchTx) {
    const u = await settle(listVibestarterLaunches());
    l = u?.find((x) => x.chainId === launch.chainId && x.escrow.toLowerCase() === launch.escrow.toLowerCase()) ?? launch;
  }
  const slug = isGenesis ? "vibes" : (l.launchTx ?? null);
  const detail = slug ? await fetchCampaignDetail(slug) : null;
  const appUrl = detail?.capsule?.appUrl ?? null;
  const repoUrl = detail?.capsule?.repoUrl ?? null;
  const founder = detail?.campaign.founder ?? null;
  let login = founder?.githubUsername ?? null;
  if (!login) {
    const id = githubIdFromAvatar(founder?.githubAvatarUrl);
    if (id) login = await resolveGithubLogin(id);
  }
  const token = (detail?.token?.address ?? l.tokenAddress ?? null) as Address | null;
  const lpLockTxHash = detail?.campaign.lpLockTxHash ?? null;
  const [appHealth, github, lpLock] = await Promise.all([
    appUrl ? probeAppHealthCached(appUrl) : Promise.resolve(null),
    login ? readGithubVelocity(login, { capsuleRepoUrl: repoUrl }) : Promise.resolve(null),
    readLpLock(launch.chainId, getAddress(launch.escrow), { token: token ? getAddress(token) : null, lockTxHash: lpLockTxHash }),
  ]);
  return {
    chainId: launch.chainId,
    escrow: getAddress(launch.escrow),
    title: l.title ?? detail?.campaign.title ?? null,
    appUrl,
    appHealth,
    repoUrl,
    githubLogin: login,
    github,
    lpLock,
    lpLockTxHash,
    vibestarterUrl: vibestarterRaiseUrl(slug),
    fetchedAt: new Date().toISOString(),
  };
}
