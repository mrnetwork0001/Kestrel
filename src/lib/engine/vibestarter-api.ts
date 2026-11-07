import { VIBESTARTER_PUBLIC_ENDPOINTS } from "@/config/contracts";
import { cached } from "@/lib/cache";

/**
 * Subset of https://app.vibestarter.xyz/api/campaigns LIST fields Kestrel consumes (verified shape 2026-11-07).
 * `status` may be any of DRAFT / ACTIVE / FUNDED / FAILED / COMPLETED / CANCELLED / REFUNDING.
 * NOTE: founder.githubUsername / githubCommits and lpLockTxHash are NOT present on list items (only on the
 * detail endpoint — see `VibestarterCampaignDetail` / `fetchCampaignDetail`). They stay optional here for
 * backward compatibility and are always undefined in practice.
 */
export interface VibestarterCampaign {
  id: string;
  title: string;
  tagline: string | null;
  status: string;
  totalRaised: string;
  escrowAddress: string | null;
  routerAddress?: string | null;
  chainId: number;
  contributorCount: number | null;
  holderCount: number | null;
  deadline?: string | null;
  fundedAt?: string | null;
  goalAmount?: string | null;
  cancellationReason?: string | null;
  lpLockTxHash?: string | null;
  token: { address: string; symbol: string; name: string; launchTxHash?: string | null; launchBlock?: number | null; capsule?: { repoUrl?: string | null } | null } | null;
  founder: {
    wallet?: string;
    githubUsername?: string | null;
    githubCommits?: number | null;
    githubAvatarUrl?: string | null;
    xIdentity?: { handle?: string; followerCount?: number } | null;
    ethosCache?: { score?: number; level?: string; humanVerified?: boolean } | null;
  } | null;
  tranches: {
    orderIndex: number;
    releasePercent: number;
    isKickstart: boolean;
    status: string;
    requestedAt: string | null;
    challengeWindowEndsAt: string | null;
    paidTxHash?: string | null;
  }[];
  capsuleSummary: { agentName?: string; provenanceTier?: number; provenanceLabel?: string } | null;
  hasActiveProposalChallenge?: boolean;
}

/** GET /api/campaigns/by-tx/{launchTx|vibes} — detail-only fields (verified live 2026-11-07). */
export interface VibestarterCampaignDetail {
  campaign: Omit<VibestarterCampaign, "founder" | "tranches"> & {
    escrowDeployTx?: string | null;
    lpLockTxHash?: string | null;
    founder: (NonNullable<VibestarterCampaign["founder"]> & { githubUsername?: string | null; githubCommits?: number | null; githubOrgs?: string[] | null; isBanned?: boolean | null }) | null;
    tranches: (VibestarterCampaign["tranches"][number] & { eligibleAt?: string | null; paidAt?: string | null; paidTxHash?: string | null; amountPaid?: string | null })[];
  };
  token: { address: string; symbol: string; name: string; totalSupply?: string; launchTxHash?: string | null; pairAddress?: string | null; pairDexUrl?: string | null } | null;
  capsule: { appUrl?: string | null; websiteUrl?: string | null; repoUrl?: string | null; projectTwitter?: string | null; agentName?: string | null; label?: string | null; tier?: number | null } | null;
}

export interface AppHealth {
  url: string;
  status: number | null;
  latencyMs: number | null;
  ok: boolean;
  checkedAt?: string;
  error?: string | null;
}

const UA = { "User-Agent": "Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)", Accept: "application/json" };

export async function fetchCampaigns(): Promise<VibestarterCampaign[]> {
  try {
    const res = await fetch(VIBESTARTER_PUBLIC_ENDPOINTS.campaignsApiUrl, {
      headers: UA,
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { campaigns?: VibestarterCampaign[] };
    return Array.isArray(json.campaigns) ? json.campaigns : [];
  } catch {
    return [];
  }
}

/** Genesis campaign detail (includes lpLockTxHash + per-tranche paidTxHash + capsule appUrl). */
export async function fetchGenesisCampaign(): Promise<(VibestarterCampaign & { capsuleAppUrl: string | null }) | null> {
  try {
    const res = await fetch(VIBESTARTER_PUBLIC_ENDPOINTS.genesisCampaignApiUrl, {
      headers: UA,
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { campaign?: VibestarterCampaign; capsule?: { appUrl?: string } };
    if (!json.campaign) return null;
    return { ...json.campaign, capsuleAppUrl: json.capsule?.appUrl ?? null };
  } catch {
    return null;
  }
}

/**
 * Detail endpoint for ANY raise (launch tx hash, or "vibes" for Genesis): founder GitHub, lpLockTxHash,
 * capsule appUrl / repoUrl, token pairAddress, per-tranche paidTxHash. Cached 120 s on the shared KV.
 */
export async function fetchCampaignDetail(launchTx: string): Promise<VibestarterCampaignDetail | null> {
  const id = launchTx.trim().toLowerCase();
  if (!/^(0x[0-9a-f]{64}|vibes)$/.test(id)) return null;
  try {
    return await cached(`vs-rest:detail:${id}`, 120, async () => {
      const res = await fetch(`${VIBESTARTER_PUBLIC_ENDPOINTS.appUrl}/api/campaigns/by-tx/${id}`, {
        headers: UA,
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Partial<VibestarterCampaignDetail> & { found?: boolean };
      if (!json.campaign) throw new Error("not found");
      return { campaign: json.campaign, token: json.token ?? null, capsule: json.capsule ?? null } as VibestarterCampaignDetail;
    });
  } catch {
    return null;
  }
}

/** REST twin of the MCP get_platform_stats tool (identical payload). Used as a fallback when the MCP is down. */
export async function fetchPlatformStatsRest(): Promise<unknown | null> {
  try {
    return await cached("vs-rest:stats", 60, async () => {
      const res = await fetch(VIBESTARTER_PUBLIC_ENDPOINTS.statsApiUrl, { headers: UA, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as unknown;
    });
  } catch {
    return null;
  }
}

/** Only probe public http(s) URLs — never localhost / private ranges (SSRF guard for API-supplied URLs). */
export function isProbeableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    if (h.includes(":") || h === "[::1]") return false;
    return true;
  } catch {
    return false;
  }
}

/** Live HTTP health probe of a founder's app URL (status + latency). Body is not downloaded. */
export async function probeAppHealth(url: string): Promise<AppHealth> {
  const checkedAt = new Date().toISOString();
  if (!isProbeableUrl(url)) return { url, status: null, latencyMs: null, ok: false, checkedAt, error: "URL not probeable" };
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: { "User-Agent": UA["User-Agent"], Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(5_000), cache: "no-store" });
    const latencyMs = Date.now() - started;
    res.body?.cancel().catch(() => undefined);
    return { url, status: res.status, latencyMs, ok: res.ok, checkedAt, error: null };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "timeout after 5 s" : e.message) : String(e);
    return { url, status: null, latencyMs: null, ok: false, checkedAt, error: msg.slice(0, 120) };
  }
}

/** probeAppHealth with a 60 s shared cache, so the Backer Shield board can probe every raise on each refresh. */
export function probeAppHealthCached(url: string): Promise<AppHealth> {
  return cached(`apphealth:${url.toLowerCase()}`, 60, () => probeAppHealth(url));
}
