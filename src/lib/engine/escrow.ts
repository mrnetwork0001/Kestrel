import { type Address, type ContractFunctionParameters, getAddress } from "viem";
import { CONTRACTS } from "@/config/contracts";
import { VIBES_ESCROW_ABI, VIBES_REGISTRY_ABI } from "@/lib/abis";
import { getPublicClientForChain, settle } from "@/lib/rpc";
import { VS_ESCROW_EXTRA_ABI, VS_FACTORY_ABI, VS_ROUTER_ABI } from "@/lib/vibestarter/abis";
import { vibestarterConfig, vibestarterRaiseUrl } from "@/lib/vibestarter/addresses";
import { listVibestarterLaunches } from "@/lib/vibestarter/launches";
import { readLpLock } from "@/lib/vibestarter/lock";
import { readTokenMeta } from "./chain-utils";
import { githubIdFromAvatar, readGithubVelocity, resolveGithubLogin } from "./github";
import type { ChainId, EscrowNextEvent, EscrowReport, RefundRadar, TrancheStatus, TrancheView } from "./types";
import { fetchCampaignDetail, fetchCampaigns, probeAppHealthCached, type VibestarterCampaign } from "./vibestarter-api";

/** Enums from the deployed VibesTranchEscrow (Sourcify exact-match, v1 0xba88… / v2 0xcBe7…). */
export const CAMPAIGN_STATES = ["Uninitialized", "Active", "Paused", "Funded", "Failed", "Frozen", "Refunding", "Completed"] as const;
export const RAISE_TYPES = ["Fixed Goal", "Open-Ended", "Pro-Rata"] as const;
export const CHALLENGE_STATES = ["None", "Pending", "Upheld", "Rejected"] as const;

const NUM_TRANCHES = 7; // 0 = 10% kickstart, 1..6 = 15% monthly (of the escrowed 85%)
const ACTIVE = 1;
const FUNDED = 3;
const FAILED = 4;
const FROZEN = 5;
const REFUNDING = 6;
const COMPLETED = 7;
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** v1 (Genesis) pending challenges expire after CHALLENGE_WINDOW (72 h); v2 after ADJUDICATION_WINDOW (7 d). */
const V2_ADJUDICATION_WINDOW = 604_800;
/** Mean founder request lag after unlock, from Vibestarter /api/ledger/stats board.tranches.avgLagDays (2026-11-07). */
const AVG_REQUEST_LAG_NOTE = "Vibestarter founders have requested on average ~3.4 days after unlock";

export async function isVibestarterEscrow(chainId: ChainId, address: Address, campaigns?: VibestarterCampaign[]): Promise<boolean> {
  const lower = address.toLowerCase();
  if (lower === CONTRACTS.base.vibesGenesisEscrow.toLowerCase()) return true;
  const list = campaigns ?? (await fetchCampaigns());
  if (list.some((c) => c.escrowAddress?.toLowerCase() === lower && c.chainId === chainId)) return true;
  // every factory on the chain (old + current on Base, Robinhood factory)
  const cfg = vibestarterConfig(chainId);
  try {
    const res = await getPublicClientForChain(chainId).multicall({
      allowFailure: true,
      contracts: cfg.factories.map((f) => ({ address: f.address, abi: VS_FACTORY_ABI, functionName: "isEscrow" as const, args: [address] as const })),
    });
    return res.some((r) => r.status === "success" && r.result === true);
  } catch {
    return false;
  }
}

export interface ReadEscrowOptions {
  /** Live HTTP probe of the founder's app URL (60 s cache). Default true — every raise, not just Genesis. */
  probeApp?: boolean;
  /** Founder GitHub live velocity (30 min cache). Default true. */
  github?: boolean;
  /** On-chain Proof-of-Lock (locker + fee claimer + pool LP supply + lock tx receipt). Default true. */
  lpLock?: boolean;
}

/** Full live read of one VibesTranchEscrow clone (one multicall, ~55 calls) + REST detail / GitHub / app / LP-lock enrichment. */
export async function readEscrow(chainId: ChainId, address: Address, opts: ReadEscrowOptions = {}): Promise<EscrowReport> {
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
    // 8.. refund radar + generation detection (v2 exposes eligibilityRegistry(), v1 trustedSigner())
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "frozenEthBalance" },
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "frozenTotalSupply" },
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "totalRefundTokensClaimed" },
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "refundingStartTime" },
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "REFUND_SWEEP_DELAY" },
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "eligibilityRegistry" },
    { address, abi: VS_ESCROW_EXTRA_ABI, functionName: "trustedSigner" },
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
    founder: Address; token: Address; raiseType: number; totalRaised: bigint; deadline: bigint; startTime: bigint; nextTranche: number; state: number;
  } | null>(0, null);
  if (!campaign) throw new Error("Address does not expose VibesTranchEscrow.getCampaign()");
  const challenge = pick<{ challenger: Address; reason: string; amount: bigint; tranche: bigint; timestamp: bigint; state: number } | null>(1, null);
  const escrowBalance = pick<bigint>(2, 0n);
  const lpCreated = pick<boolean>(3, false);
  const lpWithdrawn = pick<boolean>(4, false);
  const allClaimed = pick<boolean>(5, false);
  const oracleTime = Number(pick<bigint>(6, latest.timestamp));
  const windowSecs = Number(pick<bigint>(7, 259_200n));
  const frozenEth = pick<bigint | null>(8, null);
  const frozenSupply = pick<bigint | null>(9, null);
  const refundTokensClaimed = pick<bigint | null>(10, null);
  const refundingStart = pick<bigint | null>(11, null);
  const sweepDelay = pick<bigint | null>(12, null);
  const generation: EscrowReport["generation"] = results[13]?.status === "success" ? "v2" : results[14]?.status === "success" ? "v1" : "unknown";

  // REST: resolve the list item by escrow AND chain (cross-chain address collisions), then the detail endpoint for every raise.
  const campaigns = await fetchCampaigns();
  const api = campaigns.find((c) => c.escrowAddress?.toLowerCase() === address.toLowerCase() && c.chainId === chainId) ?? null;
  const isGenesis = chainId === 8453 && address.toLowerCase() === CONTRACTS.base.vibesGenesisEscrow.toLowerCase();
  const launchTx = api?.token?.launchTxHash ?? null;
  const slug = isGenesis ? "vibes" : launchTx;
  const detail = slug ? await fetchCampaignDetail(slug) : null;
  const apiTranches = detail?.campaign.tranches ?? api?.tranches ?? [];

  const halted = campaign.state === FAILED || campaign.state === FROZEN || campaign.state === REFUNDING;
  const scheduleLive = campaign.state === FUNDED || campaign.state === COMPLETED;
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
    else if (!scheduleLive) status = "LOCKED"; // Uninitialized / Active (still raising) / Paused — schedule not started
    else if (challenged) status = "CHALLENGED";
    else if (requestedAt > 0 && oracleTime < windowEndsAt) status = "CHALLENGE_WINDOW";
    else if (requestedAt > 0) status = "CLAIMABLE";
    else if (campaign.startTime > 0n && unlockTime <= oracleTime) status = "ELIGIBLE";
    else status = "LOCKED";
    tranches.push({
      index: i,
      label: i === 0 ? "Kickstart" : `Month ${i}`,
      bps: i === 0 ? 1000 : 1500,
      bpsOfRaised: campaign.totalRaised > 0n ? Number((amount * 10_000n) / campaign.totalRaised) : null,
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

  // Origin Capsule: each chain has its own VibesRegistry (Base 0x66b7…, Robinhood 0x3697… — chain-keyed, see addresses.ts)
  let capsule: EscrowReport["capsule"] = null;
  {
    const registry = vibestarterConfig(chainId).vibesRegistry;
    const [registered, hash] = await client
      .multicall({
        allowFailure: true,
        contracts: [
          { address: registry, abi: VIBES_REGISTRY_ABI, functionName: "isRegistered", args: [campaign.token] },
          { address: registry, abi: VIBES_REGISTRY_ABI, functionName: "capsuleHashOf", args: [campaign.token] },
        ],
      })
      .catch(() => [{ status: "failure" as const }, { status: "failure" as const }] as const);
    const h = hash.status === "success" ? (hash.result as string) : null;
    const isReg = registered.status === "success" ? Boolean(registered.result) : false;
    const label = api?.capsuleSummary?.provenanceLabel ?? detail?.capsule?.label ?? null;
    const agent = api?.capsuleSummary?.agentName ?? detail?.capsule?.agentName ?? null;
    if (isReg || h || label || agent) capsule = { registered: isReg, capsuleHash: h && h !== ZERO_HASH ? h : null, provenanceLabel: label, agentName: agent };
  }

  // ---- enrichment, all in parallel: token meta, founder GitHub, app health, Proof-of-Lock, router backer pool ----
  const founderSrc = detail?.campaign.founder ?? api?.founder ?? null;
  const appUrl = detail?.capsule?.appUrl ?? null;
  const repoUrl = detail?.capsule?.repoUrl ?? api?.token?.capsule?.repoUrl ?? null;
  const lpLockTxHash = detail?.campaign.lpLockTxHash ?? null;
  const wantLock = opts.lpLock !== false && (lpCreated || campaign.state === FUNDED || campaign.state === COMPLETED || campaign.state === FROZEN || campaign.state === REFUNDING);
  const cfg = vibestarterConfig(chainId);
  const [tokenMeta, githubLogin, appHealth, lpLock, backerPool] = await Promise.all([
    readTokenMeta(chainId, getAddress(campaign.token)).catch(() => null),
    (async () => {
      if (opts.github === false) return null;
      if (founderSrc?.githubUsername) return founderSrc.githubUsername;
      const id = githubIdFromAvatar(founderSrc?.githubAvatarUrl);
      return id ? resolveGithubLogin(id) : null;
    })(),
    opts.probeApp !== false && appUrl ? probeAppHealthCached(appUrl) : Promise.resolve(null),
    wantLock ? readLpLock(chainId, address, { token: getAddress(campaign.token), lockTxHash: lpLockTxHash }) : Promise.resolve(null),
    settle(client.readContract({ address: cfg.router, abi: VS_ROUTER_ABI, functionName: "backerTokensForClaims", args: [campaign.token] })),
  ]);
  const founderGithub = githubLogin ? await readGithubVelocity(githubLogin, { capsuleRepoUrl: repoUrl }).catch(() => null) : null;

  const challengeView = challenge && challenge.state !== 0
    ? {
        challenger: challenge.challenger,
        reason: challenge.reason.slice(0, 280),
        tranche: Number(challenge.tranche),
        timestamp: Number(challenge.timestamp),
        state: challenge.state,
        stateLabel: CHALLENGE_STATES[challenge.state] ?? String(challenge.state),
      }
    : null;
  const activeChallenge = challengeView && challengeView.state === 1 ? challengeView : null;
  const adjudicationSecs = generation === "v2" ? V2_ADJUDICATION_WINDOW : windowSecs;

  // most recent requested window (open or closed) — "Month 4 window closed 14h ago, unchallenged"
  const requested = tranches.filter((t) => t.requestedAt > 0).sort((a, b) => b.requestedAt - a.requestedAt)[0] ?? null;
  const lastWindow = requested
    ? { tranche: requested.index, label: requested.label, requestedAt: requested.requestedAt, windowEndsAt: requested.windowEndsAt, open: oracleTime < requested.windowEndsAt, challenged: requested.challenged, claimed: requested.claimed, amount: requested.amount }
    : null;

  const nextEvent = computeNextEvent({
    state: campaign.state,
    deadline: Number(campaign.deadline),
    nextTranche: campaign.nextTranche,
    tranches,
    oracleTime,
    activeChallenge,
    adjudicationSecs,
    refundSweepAfter: refundingStart && refundingStart > 0n && sweepDelay ? Number(refundingStart + sweepDelay) : null,
    symbol: tokenMeta?.symbol ?? api?.token?.symbol ?? null,
  });

  const refund = buildRefundRadar({
    state: campaign.state,
    escrowBalance,
    frozenEth,
    frozenSupply,
    refundTokensClaimed,
    refundingStart,
    sweepDelay,
    decimals: tokenMeta?.decimals ?? 18,
    symbol: tokenMeta?.symbol ?? api?.token?.symbol ?? "tokens",
    contributorCount: api?.contributorCount ?? null,
  });

  return {
    chainId,
    address,
    title: api?.title ?? detail?.campaign.title ?? null,
    tagline: api?.tagline ?? detail?.campaign.tagline ?? null,
    apiStatus: api?.status ?? detail?.campaign.status ?? null,
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
    lpLockTxHash,
    allTranchesClaimed: allClaimed,
    activeChallenge,
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
    contributorCount: api?.contributorCount ?? detail?.campaign.contributorCount ?? null,
    holderCount: api?.holderCount ?? null,
    appHealth,
    block: { chainId, number: latest.number.toString(), timestamp: Number(latest.timestamp) },
    launchTx: isGenesis ? "vibes" : launchTx,
    vibestarterUrl: vibestarterRaiseUrl(slug),
    generation,
    appUrl,
    repoUrl,
    lpLock,
    founderGithub,
    lastChallenge: challengeView && challengeView.state !== 1 ? challengeView : null,
    nextEvent,
    lastWindow,
    refund,
    raiseDeadline: campaign.deadline > 0n ? Number(campaign.deadline) : null,
    backerTokensUnclaimed: backerPool != null ? backerPool.toString() : null,
    tokenDecimals: tokenMeta?.decimals ?? null,
  };
}

/** The next thing to count down to — always populated for live raises, even when no challenge window is open. */
function computeNextEvent(i: {
  state: number;
  deadline: number;
  nextTranche: number;
  tranches: TrancheView[];
  oracleTime: number;
  activeChallenge: { tranche: number; timestamp: number } | null;
  adjudicationSecs: number;
  refundSweepAfter: number | null;
  symbol: string | null;
}): EscrowNextEvent | null {
  const { state, oracleTime: now } = i;
  if (state === ACTIVE || state === 0 || state === 2) {
    if (i.deadline > now) return { kind: "raise-deadline", at: i.deadline, label: "Raise closes", detail: "Contributions close; the escrow then finalizes to Funded or Failed.", tranche: null, amount: null };
    return { kind: "raise-deadline", at: null, label: "Awaiting finalize()", detail: "Deadline passed — anyone can call finalize() to settle the raise.", tranche: null, amount: null };
  }
  if (state === REFUNDING) {
    if (i.refundSweepAfter && i.refundSweepAfter > now)
      return { kind: "refund-sweep", at: i.refundSweepAfter, label: "Holder refund window closes", detail: "After this the admin may sweep unclaimed refund ETH (REFUND_SWEEP_DELAY = 180 days from refunding start).", tranche: null, amount: null };
    return null;
  }
  if (state !== FUNDED) return null;
  if (i.activeChallenge) {
    const at = i.activeChallenge.timestamp + i.adjudicationSecs;
    return { kind: "challenge-adjudication", at, label: `Challenge on Month ${i.activeChallenge.tranche} auto-expires`, detail: "Admin must uphold or reject before this, otherwise anyone may expire it (full bond returned).", tranche: i.activeChallenge.tranche, amount: null };
  }
  const open = i.tranches.find((t) => t.status === "CHALLENGE_WINDOW");
  if (open) return { kind: "window-closes", at: open.windowEndsAt, label: `${open.label} challenge window closes`, detail: "Eligible token holders can challenge this tranche until the window closes.", tranche: open.index, amount: open.amount };
  const claimable = i.tranches.find((t) => t.status === "CLAIMABLE");
  if (claimable) return { kind: "awaiting-claim", at: null, label: `${claimable.label} claimable by founder`, detail: "The 72 h window closed unchallenged; the founder can claim this tranche at any time.", tranche: claimable.index, amount: claimable.amount };
  const n = i.tranches[i.nextTranche];
  if (!n) return null;
  if (n.unlockTime > now)
    return { kind: "tranche-unlock", at: n.unlockTime, label: `${n.label} unlocks`, detail: `Once unlocked the founder can request it, which opens a 72 h backer challenge window. ${AVG_REQUEST_LAG_NOTE}.`, tranche: n.index, amount: n.amount };
  return { kind: "awaiting-request", at: null, label: `${n.label} unlocked — awaiting founder request`, detail: `A 72 h challenge window opens the moment the founder calls requestTranche(${n.index}). ${AVG_REQUEST_LAG_NOTE}.`, tranche: n.index, amount: n.amount };
}

/** Refund Radar for Failed (contributor refunds) and Refunding (merkle holder refunds) escrows. BigInt math only. */
function buildRefundRadar(i: {
  state: number;
  escrowBalance: bigint;
  frozenEth: bigint | null;
  frozenSupply: bigint | null;
  refundTokensClaimed: bigint | null;
  refundingStart: bigint | null;
  sweepDelay: bigint | null;
  decimals: number;
  symbol: string;
  contributorCount: number | null;
}): RefundRadar | null {
  if (i.state === FAILED) {
    const allClaimed = i.escrowBalance === 0n;
    return {
      mode: "contributor",
      claimFunction: "claimContributorRefund()",
      escrowBalance: i.escrowBalance.toString(),
      sweepAfter: null,
      refundingStartTime: null,
      frozenEthBalance: null,
      frozenTotalSupply: null,
      tokensRedeemed: null,
      redeemedBps: null,
      unclaimedEthEstimate: i.escrowBalance.toString(),
      ethPerMillionTokens: null,
      allClaimed,
      proofSource: null,
      note: allClaimed
        ? `Raise failed and the escrow holds 0 ETH — every contributor refund${i.contributorCount ? ` (${i.contributorCount} backers)` : ""} has been claimed.`
        : "Raise failed: each contributor can call claimContributorRefund() — no proof needed and no deadline (Failed escrows have no sweep).",
    };
  }
  if (i.state === REFUNDING || i.state === FROZEN) {
    const fe = i.frozenEth ?? null;
    const fs = i.frozenSupply ?? null;
    const redeemed = i.refundTokensClaimed ?? null;
    const sweepAfter = i.refundingStart && i.refundingStart > 0n && i.sweepDelay ? Number(i.refundingStart + i.sweepDelay) : null;
    const unclaimed = fe !== null && fs && fs > 0n && redeemed !== null ? (fe * (fs - redeemed)) / fs : null;
    const perMillion = fe !== null && fs && fs > 0n ? (fe * 1_000_000n * 10n ** BigInt(i.decimals)) / fs : null;
    return {
      mode: "holder",
      claimFunction: "claimHolderRefund(uint256 tokenAmount, bytes32[] proof)",
      escrowBalance: i.escrowBalance.toString(),
      sweepAfter,
      refundingStartTime: i.refundingStart && i.refundingStart > 0n ? Number(i.refundingStart) : null,
      frozenEthBalance: fe?.toString() ?? null,
      frozenTotalSupply: fs?.toString() ?? null,
      tokensRedeemed: redeemed?.toString() ?? null,
      redeemedBps: redeemed !== null && fs && fs > 0n ? Number((redeemed * 10_000n) / fs) : null,
      unclaimedEthEstimate: unclaimed?.toString() ?? null,
      ethPerMillionTokens: perMillion?.toString() ?? null,
      allClaimed: unclaimed === 0n,
      proofSource: "Vibestarter's off-chain refund merkle tree (claim on the raise page)",
      note:
        i.state === FROZEN
          ? "Campaign frozen; refunds open once the admin finalizes the refund merkle root (state → Refunding)."
          : `Holders at the snapshot redeem pro-rata ETH for their ${i.symbol} with a merkle proof from Vibestarter.`,
    };
  }
  return null;
}

export interface EscrowListItem {
  chainId: ChainId;
  address: string;
  title: string | null;
  apiStatus: string | null;
  source: string[];
}

/** Whole launch universe: every factory on Base (old + current) and Robinhood Chain, the public REST list and the Vibestarter MCP. */
export async function listEscrows(): Promise<EscrowListItem[]> {
  const launches = await listVibestarterLaunches();
  return launches.map((l) => ({ chainId: l.chainId, address: l.escrow, title: l.title, apiStatus: l.apiStatus ?? l.mcpStatus, source: [...l.sources] }));
}

/** Read every known escrow in parallel for the Backer Shield board (app probes + GitHub velocity + Proof-of-Lock, all cached). */
export async function readAllEscrows(opts: ReadEscrowOptions = {}): Promise<EscrowReport[]> {
  const list = await listEscrows();
  const reports = await Promise.all(list.map((e) => readEscrow(e.chainId, getAddress(e.address), opts).catch(() => null)));
  return reports
    .filter((r): r is EscrowReport => r !== null)
    .sort((a, b) => (BigInt(b.totalRaised) > BigInt(a.totalRaised) ? 1 : -1));
}
