import { VIBESTARTER_PUBLIC_ENDPOINTS } from "@/config/contracts";
import { cached } from "@/lib/cache";
import { safeRequest, SsrfError } from "@/lib/pager/ssrf";

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

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OPTS: { allowHttp: boolean; ports: number[]; timeoutMs: number } = { allowHttp: true, ports: [80, 443], timeoutMs: PROBE_TIMEOUT_MS };

/**
 * Live HTTP health probe of a founder's app URL (status + latency), through the pager's SSRF guard: the URL is
 * re-vetted (public DNS answers only, ports 80/443, no embedded credentials), the socket is pinned to the vetted IP,
 * redirects are NOT followed (a 3xx is reported as reachable, with its Location host) and the body is not read
 * beyond 1 KiB. HEAD first; servers that refuse HEAD (405/501) get one small GET.
 *
 * Latency is measured on a fresh, non-pooled connection (DNS + TCP + TLS + first byte) — never a Next.js fetch
 * memo / dedupe hit, which is what produced the implausible 1–3 ms readings this used to report.
 */
export async function probeAppHealth(url: string): Promise<AppHealth> {
  const checkedAt = new Date().toISOString();
  if (!isProbeableUrl(url)) return { url, status: null, latencyMs: null, ok: false, checkedAt, error: "URL not probeable" };
  const headers = { "User-Agent": UA["User-Agent"], Accept: "text/html,*/*;q=0.8" };
  try {
    let res = await safeRequest(url, { ...PROBE_OPTS, method: "HEAD", headers, maxBytes: 1_024 });
    if (res.status === 405 || res.status === 501) res = await safeRequest(url, { ...PROBE_OPTS, method: "GET", headers, maxBytes: 1_024 });
    const redirect = res.status >= 300 && res.status < 400;
    const location = redirect ? locationHost(url, res.headers.location) : null;
    return {
      url,
      status: res.status,
      latencyMs: res.durationMs,
      // 2xx = up; 3xx = the server answered and redirects (not followed, by design); 4xx/5xx = down for users.
      ok: res.status >= 200 && res.status < 400,
      checkedAt,
      error: redirect ? `redirects${location ? ` to ${location}` : ""} (not followed)` : null,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = e instanceof SsrfError ? `blocked by SSRF guard: ${raw.replace(/^Webhook /, "")}` : /timed out/i.test(raw) ? `timeout after ${PROBE_TIMEOUT_MS / 1000} s` : raw;
    return { url, status: null, latencyMs: null, ok: false, checkedAt, error: msg.slice(0, 120) };
  }
}

function locationHost(base: string, loc: string | string[] | undefined): string | null {
  const v = Array.isArray(loc) ? loc[0] : loc;
  if (!v) return null;
  try {
    const u = new URL(v, base);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80);
  } catch {
    return null;
  }
}

/**
 * probeAppHealth with a 60 s shared cache, so the Backer Shield board can probe every raise on each refresh.
 * A cached result keeps the latency and `checkedAt` of the probe that actually ran (the UI shows "probed Xs ago").
 */
export function probeAppHealthCached(url: string): Promise<AppHealth> {
  return cached(`apphealth:v2:${url.toLowerCase()}`, 60, () => probeAppHealth(url));
}
