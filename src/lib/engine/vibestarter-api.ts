import { VIBESTARTER_PUBLIC_ENDPOINTS } from "@/config/contracts";

/** Subset of https://app.vibestarter.xyz/api/campaigns fields Kestrel consumes (verified shape 2026-11-04). */
export interface VibestarterCampaign {
  id: string;
  title: string;
  tagline: string | null;
  status: string;
  totalRaised: string;
  escrowAddress: string | null;
  chainId: number;
  contributorCount: number | null;
  holderCount: number | null;
  lpLockTxHash?: string | null;
  token: { address: string; symbol: string; name: string } | null;
  founder: {
    wallet?: string;
    githubUsername?: string | null;
    githubCommits?: number | null;
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

/** Live HTTP health probe of a founder's app URL (status + latency). */
export async function probeAppHealth(url: string): Promise<{ url: string; status: number | null; latencyMs: number | null; ok: boolean }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers: { "User-Agent": UA["User-Agent"] }, redirect: "follow", signal: AbortSignal.timeout(6_000), cache: "no-store" });
    return { url, status: res.status, latencyMs: Date.now() - started, ok: res.ok };
  } catch {
    return { url, status: null, latencyMs: null, ok: false };
  }
}
