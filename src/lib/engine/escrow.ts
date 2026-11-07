import { type Address, type ContractFunctionParameters, getAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { VIBES_ESCROW_ABI, VIBES_ESCROW_FACTORY_ABI, VIBES_REGISTRY_ABI } from "@/lib/abis";
import { getPublicClientForChain } from "@/lib/rpc";
import { readTokenMeta } from "./chain-utils";
import type { ChainId, EscrowReport, TrancheStatus, TrancheView } from "./types";
import { fetchCampaigns, fetchGenesisCampaign, probeAppHealth, type VibestarterCampaign } from "./vibestarter-api";

/** Enums copied from VibesTranchEscrow.sol (github.com/vibesprotocol/vibestarter-contracts). */
export const CAMPAIGN_STATES = ["Uninitialized", "Active", "Paused", "Funded", "Failed", "Frozen", "Refunding", "Completed"] as const;
export const RAISE_TYPES = ["Fixed Goal", "Open-Ended", "Pro-Rata"] as const;
export const CHALLENGE_STATES = ["None", "Pending", "Upheld", "Rejected"] as const;

const NUM_TRANCHES = 7; // 0 = 10% kickstart, 1..6 = 15% monthly
const FUNDED = 3;
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export async function isVibestarterEscrow(chainId: ChainId, address: Address, campaigns?: VibestarterCampaign[]): Promise<boolean> {
  const lower = address.toLowerCase();
  if (lower === CONTRACTS.base.vibesGenesisEscrow.toLowerCase()) return true;
  const list = campaigns ?? (await fetchCampaigns());
  if (list.some((c) => c.escrowAddress?.toLowerCase() === lower && c.chainId === chainId)) return true;
  if (chainId === 8453) {
    try {
      return await getPublicClientForChain(8453).readContract({ address: CONTRACTS.base.vibesTranchEscrowFactory, abi: VIBES_ESCROW_FACTORY_ABI, functionName: "isEscrow", args: [address] });
    } catch {
      return false;
    }
  }
  return false;
}

/** Full live read of one VibesTranchEscrow clone (one multicall, ~45 calls) + API enrichment. */
export async function readEscrow(chainId: ChainId, address: Address, opts: { probeApp?: boolean } = {}): Promise<EscrowReport> {
  const client = getPublicClientForChain(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const base: ContractFunctionParameters[] = [
    { address, abi: VIBES_ESCROW_ABI, functionName: "getCampaign" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "getActiveChallenge" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "getEscrowBalance" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "lpCreated" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "lpWithdrawn" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "allTranchesClaimed" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "getCurrentTime" },
    { address, abi: VIBES_ESCROW_ABI, functionName: "CHALLENGE_WINDOW" },
  ];
  const per: ContractFunctionParameters[] = Array.from({ length: NUM_TRANCHES }, (_, i): ContractFunctionParameters[] => [
    { address, abi: VIBES_ESCROW_ABI, functionName: "trancheClaimed", args: [i] },
    { address, abi: VIBES_ESCROW_ABI, functionName: "trancheRequestedAt", args: [i] },
    { address, abi: VIBES_ESCROW_ABI, functionName: "trancheChallenged", args: [i] },
    { address, abi: VIBES_ESCROW_ABI, functionName: "getTrancheAmount", args: [i] },
    { address, abi: VIBES_ESCROW_ABI, functionName: "getTrancheUnlockTime", args: [i] },
  ]).flat();

  const results = await client.multicall({ allowFailure: true, blockNumber: latest.number, contracts: [...base, ...per] });
  const pick = <T,>(i: number, fallback: T): T => (results[i]?.status === "success" ? (results[i].result as T) : fallback);

  const campaign = pick<{
    founder: Address; token: Address; raiseType: number; totalRaised: bigint; startTime: bigint; nextTranche: number; state: number;
  } | null>(0, null);
  if (!campaign) throw new Error("Address does not expose VibesTranchEscrow.getCampaign()");
  const challenge = pick<{ challenger: Address; reason: string; tranche: bigint; timestamp: bigint; state: number } | null>(1, null);
  const escrowBalance = pick<bigint>(2, 0n);
  const lpCreated = pick<boolean>(3, false);
  const lpWithdrawn = pick<boolean>(4, false);
  const allClaimed = pick<boolean>(5, false);
  const oracleTime = Number(pick<bigint>(6, latest.timestamp));
  const windowSecs = Number(pick<bigint>(7, 259_200n));

  const campaigns = await fetchCampaigns();
  const api = campaigns.find((c) => c.escrowAddress?.toLowerCase() === address.toLowerCase()) ?? null;
  const isGenesis = address.toLowerCase() === CONTRACTS.base.vibesGenesisEscrow.toLowerCase();
  const genesis = isGenesis ? await fetchGenesisCampaign() : null;
  const apiTranches = (genesis ?? api)?.tranches ?? [];

  const halted = campaign.state !== FUNDED && campaign.state !== 7;
  const tranches: TrancheView[] = [];
  for (let i = 0; i < NUM_TRANCHES; i++) {
    const o = base.length + i * 5;
    const claimed = pick<boolean>(o, false);
    const requestedAt = Number(pick<bigint>(o + 1, 0n));
    const challenged = pick<boolean>(o + 2, false);
    const amount = pick<bigint>(o + 3, 0n);
    const unlockTime = Number(pick<bigint>(o + 4, 0n));
    const windowEndsAt = requestedAt > 0 ? requestedAt + windowSecs : 0;
    let status: TrancheStatus;
    if (claimed) status = "PAID";
    else if (halted) status = "HALTED";
    else if (challenged) status = "CHALLENGED";
    else if (requestedAt > 0 && oracleTime < windowEndsAt) status = "CHALLENGE_WINDOW";
    else if (requestedAt > 0) status = "CLAIMABLE";
    else if (campaign.startTime > 0n && unlockTime <= oracleTime) status = "ELIGIBLE";
    else status = "LOCKED";
    tranches.push({
      index: i,
      label: i === 0 ? "Kickstart" : `Month ${i}`,
      bps: i === 0 ? 1000 : 1500,
      amount: amount.toString(),
      unlockTime: campaign.startTime > 0n ? unlockTime : 0,
      requestedAt,
      windowEndsAt,
      claimed,
      challenged,
      status,
      paidTxHash: apiTranches.find((t) => t.orderIndex === i)?.paidTxHash ?? null,
    });
  }

  let challengeThresholdBps: number | null = null;
  if (campaign.nextTranche >= 1 && campaign.nextTranche <= 6) {
    try {
      challengeThresholdBps = Number(await client.readContract({ address, abi: VIBES_ESCROW_ABI, functionName: "getChallengeThreshold", args: [campaign.nextTranche] }));
    } catch {
      /* optional */
    }
  }

  // Origin Capsule (VibesRegistry lives on Base)
  let capsule: EscrowReport["capsule"] = null;
  if (chainId === 8453) {
    const reg = getPublicClientForChain(8453);
    const [registered, hash] = await reg.multicall({
      allowFailure: true,
      contracts: [
        { address: CONTRACTS.base.vibesRegistry, abi: VIBES_REGISTRY_ABI, functionName: "isRegistered", args: [campaign.token] },
        { address: CONTRACTS.base.vibesRegistry, abi: VIBES_REGISTRY_ABI, functionName: "capsuleHashOf", args: [campaign.token] },
      ],
    });
    const h = hash.status === "success" ? hash.result : null;
    capsule = {
      registered: registered.status === "success" ? registered.result : false,
      capsuleHash: h && h !== ZERO_HASH ? h : null,
      provenanceLabel: api?.capsuleSummary?.provenanceLabel ?? null,
      agentName: api?.capsuleSummary?.agentName ?? null,
    };
  } else if (api?.capsuleSummary) {
    capsule = { registered: false, capsuleHash: null, provenanceLabel: api.capsuleSummary.provenanceLabel ?? null, agentName: api.capsuleSummary.agentName ?? null };
  }

  const tokenMeta = await readTokenMeta(chainId, getAddress(campaign.token)).catch(() => null);
  const founderSrc = (genesis ?? api)?.founder ?? null;
  const appUrl = genesis?.capsuleAppUrl ?? null;

  return {
    chainId,
    address,
    title: api?.title ?? genesis?.title ?? null,
    tagline: api?.tagline ?? genesis?.tagline ?? null,
    apiStatus: api?.status ?? genesis?.status ?? null,
    state: campaign.state,
    stateLabel: CAMPAIGN_STATES[campaign.state] ?? `Unknown(${campaign.state})`,
    raiseTypeLabel: RAISE_TYPES[campaign.raiseType] ?? `Type ${campaign.raiseType}`,
    founder: campaign.founder,
    token: campaign.token,
    tokenSymbol: tokenMeta?.symbol ?? api?.token?.symbol ?? null,
    totalRaised: campaign.totalRaised.toString(),
    escrowBalance: escrowBalance.toString(),
    nextTranche: campaign.nextTranche,
    startTime: Number(campaign.startTime),
    oracleTime,
    challengeWindowSeconds: windowSecs,
    lpCreated,
    lpWithdrawn,
    lpLockTxHash: genesis?.lpLockTxHash ?? api?.lpLockTxHash ?? null,
    allTranchesClaimed: allClaimed,
    activeChallenge:
      challenge && challenge.state !== 0
        ? {
            challenger: challenge.challenger,
            reason: challenge.reason.slice(0, 280),
            tranche: Number(challenge.tranche),
            timestamp: Number(challenge.timestamp),
            state: challenge.state,
            stateLabel: CHALLENGE_STATES[challenge.state] ?? String(challenge.state),
          }
        : null,
    challengeThresholdBps,
    tranches,
    capsule,
    founderSignals: founderSrc
      ? {
          githubUsername: founderSrc.githubUsername ?? null,
          githubCommits: founderSrc.githubCommits ?? null,
          ethosScore: founderSrc.ethosCache?.score ?? null,
          ethosLevel: founderSrc.ethosCache?.level ?? null,
          xHandle: founderSrc.xIdentity?.handle ?? null,
          xFollowers: founderSrc.xIdentity?.followerCount ?? null,
          humanVerified: founderSrc.ethosCache?.humanVerified ?? null,
        }
      : null,
    contributorCount: api?.contributorCount ?? genesis?.contributorCount ?? null,
    holderCount: api?.holderCount ?? null,
    appHealth: opts.probeApp && appUrl ? await probeAppHealth(appUrl) : null,
    block: { chainId, number: latest.number.toString(), timestamp: Number(latest.timestamp) },
  };
}

export interface EscrowListItem {
  chainId: ChainId;
  address: string;
  title: string | null;
  apiStatus: string | null;
  source: string[];
}

/** Union of factory.getAllEscrows() (Base), the Genesis escrow, and every campaign escrow in the public API (both chains). */
export async function listEscrows(): Promise<EscrowListItem[]> {
  const map = new Map<string, EscrowListItem>();
  const add = (chainId: ChainId, address: string, src: string, title: string | null = null, apiStatus: string | null = null) => {
    const key = `${chainId}:${address.toLowerCase()}`;
    const cur = map.get(key);
    if (cur) {
      cur.source.push(src);
      cur.title ??= title;
      cur.apiStatus ??= apiStatus;
    } else {
      map.set(key, { chainId, address: getAddress(address), title, apiStatus, source: [src] });
    }
  };
  add(8453, CONTRACTS.base.vibesGenesisEscrow, "genesis", "Vibestarter");
  const [factoryList, campaigns] = await Promise.all([
    getPublicClientForChain(8453)
      .readContract({ address: CONTRACTS.base.vibesTranchEscrowFactory, abi: VIBES_ESCROW_FACTORY_ABI, functionName: "getAllEscrows" })
      .catch(() => [] as readonly Address[]),
    fetchCampaigns(),
  ]);
  for (const a of factoryList) add(8453, a, "factory");
  for (const c of campaigns) {
    if (c.escrowAddress && (c.chainId === 8453 || c.chainId === 4663)) add(c.chainId, c.escrowAddress, "api", c.title, c.status);
  }
  return [...map.values()];
}

/** Read every known escrow in parallel (no app probes) for the Backer Shield board. */
export async function readAllEscrows(): Promise<EscrowReport[]> {
  const list = await listEscrows();
  const reports = await Promise.all(list.map((e) => readEscrow(e.chainId, getAddress(e.address)).catch(() => null)));
  return reports
    .filter((r): r is EscrowReport => r !== null)
    .sort((a, b) => (BigInt(b.totalRaised) > BigInt(a.totalRaised) ? 1 : -1));
}
