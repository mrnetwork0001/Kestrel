import { parseAbi } from "viem";

/**
 * Vibestarter ABIs not covered by src/lib/abis.ts, transcribed from Sourcify exact-match sources of the
 * deployed contracts (VibesLPLockerV2, VibesLPFeeClaimer, VibesTranchEscrow v1 `0xba88…` / v2 `0xcBe7…`,
 * VibesLaunchRouterV2). Every tranche index on the deployed escrows is uint8.
 */

export const VS_FACTORY_ABI = parseAbi([
  "function getAllEscrows() view returns (address[])",
  "function totalEscrows() view returns (uint256)",
  "function isEscrow(address escrow) view returns (bool)",
]);

export const VS_LP_LOCKER_ABI = parseAbi([
  "struct LockedLP { address token; address pool; uint256 tokenAmount; uint256 ethAmount; uint256 lpAmount; uint256 timestamp; address campaign; }",
  "function getAllLockedPositions() view returns (LockedLP[])",
  "function totalLockedPositions() view returns (uint256)",
  "function getLockedPosition(address campaign) view returns (LockedLP)",
  "function verifyLPLocked(address campaign) view returns (bool locked, uint256 heldBalance)",
  "function campaignToFeeClaimer(address campaign) view returns (address)",
  "function hasRescuedLP(address campaign) view returns (bool)",
  "event LPCreatedAndLocked(address indexed token, address indexed pool, address indexed campaign, uint256 tokenAmount, uint256 ethAmount, uint256 lpAmount)",
]);

export const VS_LP_FEE_CLAIMER_ABI = parseAbi([
  "function pool() view returns (address)",
  "function campaign() view returns (address)",
  "function lpBalance() view returns (uint256)",
  "function platformFeeRecipient() view returns (address)",
  "function treasuryEscrow() view returns (address)",
]);

export const VS_LP_TOKEN_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export const VS_ROUTER_ABI = parseAbi([
  "function lpStatus(address token) view returns (uint8)",
  "function finalizationPhase(address token) view returns (uint8)",
  "function backerTokensForClaims(address token) view returns (uint256)",
  "function tokenToEscrow(address token) view returns (address)",
  "function lpLocker() view returns (address)",
]);

/** Refund + generation-detection surface shared by v1 and v2 escrows (verified selectors). */
export const VS_ESCROW_EXTRA_ABI = parseAbi([
  "struct Contribution { uint256 amount; bool refundClaimed; bool excessClaimed; }",
  "function getContribution(address contributor) view returns (Contribution)",
  "function refundClaimedFromMerkle(address holder) view returns (bool)",
  "function claimContributorRefund()",
  "function frozenEthBalance() view returns (uint256)",
  "function frozenTotalSupply() view returns (uint256)",
  "function totalRefundTokensClaimed() view returns (uint256)",
  "function refundingStartTime() view returns (uint256)",
  "function REFUND_SWEEP_DELAY() view returns (uint256)",
  "function totalExcessRefundLiability() view returns (uint256)",
  "function pendingPlatformFees() view returns (uint256)",
  "function eligibilityRegistry() view returns (address)",
  "function trustedSigner() view returns (address)",
  "function admin() view returns (address)",
  "function challengeSeq() view returns (uint256)",
  "error NotAContributor()",
  "error AlreadyClaimed()",
  "error InvalidState(uint8 current, uint8 required)",
  "error EthTransferFailed()",
]);

/** Router LP status enum (VibesLaunchRouterV2.lpStatus). */
export const LP_STATUS_LABELS = ["None", "Created", "Rescued"] as const;
