import { type Abi, type Address, decodeErrorResult, type Hex, parseAbi } from "viem";

/**
 * ABIs + addresses for the Backer Challenge Co-pilot.
 *
 * Fragments are copied from the Sourcify exact-match verified sources of the deployed escrow
 * implementations (v2 `0xcBe7…a43d` on Base / `0xd579…9D44` on Robinhood Chain, v1 Genesis `0xbA88…202A`)
 * and `VibesEligibilityRegistry` (`0x7862…AAe2e`). Tranche indexes are `uint8` on every deployed escrow.
 */

/** Read + write surface shared by v1 and v2 escrows (no signature arguments). */
export const ESCROW_CHALLENGE_COMMON_ABI = parseAbi([
  "struct Campaign { address founder; address token; uint8 raiseType; uint256 goal; uint256 softCap; uint256 deadline; uint256 raiseStart; uint256 totalRaised; uint256 totalCommitted; uint256 startTime; uint8 nextTranche; uint8 state; bytes32 refundMerkleRoot; uint256 snapshotBlock; }",
  "struct Challenge { address challenger; string reason; uint256 amount; uint256 tranche; uint256 timestamp; uint8 state; }",
  "struct Contribution { uint256 amount; bool refundClaimed; bool excessClaimed; }",
  "function getCampaign() view returns (Campaign)",
  "function getActiveChallenge() view returns (Challenge)",
  "function getContribution(address _contributor) view returns (Contribution)",
  "function getEscrowBalance() view returns (uint256)",
  "function getCurrentTime() view returns (uint256)",
  "function getTrancheAmount(uint8 _tranche) view returns (uint256)",
  "function getTrancheUnlockTime(uint8 _tranche) view returns (uint256)",
  "function getChallengeThreshold(uint8 tranche) pure returns (uint256)",
  "function trancheClaimed(uint8) view returns (bool)",
  "function trancheRequestedAt(uint8) view returns (uint256)",
  "function trancheChallenged(uint8) view returns (bool)",
  "function challengeSeq() view returns (uint256)",
  "function challengeVoteBySeq(uint256 seq, address voter) view returns (uint8)",
  "function lastChallengeTime(address) view returns (uint256)",
  "function admin() view returns (address)",
  "function platformFeeBps() view returns (uint96)",
  "function PLATFORM_FEE_BPS() view returns (uint256)",
  "function timeOracle() view returns (address)",
  "function pendingPlatformFees() view returns (uint256)",
  "function totalExcessRefundLiability() view returns (uint256)",
  "function frozenEthBalance() view returns (uint256)",
  "function frozenTotalSupply() view returns (uint256)",
  "function lpCreated() view returns (bool)",
  "function lpWithdrawn() view returns (bool)",
  "function CHALLENGE_WINDOW() view returns (uint256)",
  "function CHALLENGE_COOLDOWN() view returns (uint256)",
  "function CHALLENGE_SLASH_BPS() view returns (uint256)",
  "function expireChallengeIfNeeded()",
  "function claimContributorRefund()",
  "event ChallengeRaised(address indexed challenger, uint8 tranche, uint256 stake, string reason)",
  "event ChallengeSupported(address indexed supporter, uint8 tranche, string additionalContext)",
  "event ChallengeOpposed(address indexed opposer, uint8 tranche, string additionalContext)",
  "event ChallengeUpheld(address indexed challenger, uint8 tranche)",
  "event ChallengeRejected(address indexed challenger, uint8 tranche, uint256 slashed)",
  "event TrancheRequested(uint8 indexed tranche, uint256 timestamp)",
  // Custom errors (identical names on v1 and v2) — lets viem decode reverts to names.
  "error OnlyAdmin()",
  "error InvalidState(uint8 current, uint8 required)",
  "error TrancheAlreadyClaimed(uint8 tranche)",
  "error ChallengePending()",
  "error NoChallengeActive()",
  "error ChallengeWindowClosed()",
  "error InsufficientTokensToChallenge()",
  "error NotAContributor()",
  "error AlreadyClaimed()",
  "error InvalidTranche()",
  "error TrancheNotRequested()",
  "error TrancheAlreadyChallenged()",
  "error NotEligible()",
  "error ChallengeCooldownActive()",
  "error NotTokenHolder()",
  "error AlreadyVoted()",
  "error NoRedeemableSupply()",
  "error EthTransferFailed()",
  "error FinalizationPhase2Pending()",
  "error RouterFinalizationProgressed()",
  "error SafeERC20FailedOperation(address token)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/** v2 (Corvo / Onetoken / Loyal Spark + Robinhood Chain): gated by the on-chain eligibility registry. */
export const ESCROW_CHALLENGE_V2_ABI = parseAbi([
  "function raiseChallenge(string _reason)",
  "function supportChallenge(string _additionalContext)",
  "function opposeChallenge(string _additionalContext)",
  "function eligibilityRegistry() view returns (address)",
  "function ADJUDICATION_WINDOW() view returns (uint256)",
]);

/** v1 (Genesis `$VIBES` escrow): every challenge action needs a Vibestarter-issued EIP-712 TermsAcceptance signature. */
export const ESCROW_CHALLENGE_V1_ABI = parseAbi([
  "function raiseChallenge(string _reason, uint256 nonce, uint256 deadline, bytes signature)",
  "function supportChallenge(string _additionalContext, uint256 nonce, uint256 deadline, bytes signature)",
  "function opposeChallenge(string _additionalContext, uint256 nonce, uint256 deadline, bytes signature)",
  "function trustedSigner() view returns (address)",
  "function nonces(address) view returns (uint256)",
  "error InvalidNonce()",
  "error SignatureExpired()",
  "error InvalidSignature()",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
]);

/** Admin adjudication — used ONLY inside eth_simulateV1 dry-runs (impersonation never leaves the simulation). */
export const ESCROW_ADMIN_ABI = parseAbi(["function upholdChallenge()", "function rejectChallenge()"]);

/** VibesEligibilityRegistry — Credential layout verified against the Sourcify source. */
export const ELIGIBILITY_REGISTRY_ABI = parseAbi([
  "struct Credential { address attestor; uint40 issuedAt; uint40 expiresAt; uint8 tier; uint8 jurisdictionClass; }",
  "function isEligible(address wallet) view returns (bool)",
  "function tierOf(address wallet) view returns (uint8)",
  "function credentialOf(address wallet) view returns (Credential)",
]);

/** Launch router (fallback delegatecalls the extension that hosts the backer token claim). */
export const ROUTER_CLAIM_ABI = parseAbi([
  "function getClaimableTokens(address token, address backer) view returns (uint256)",
  "function hasClaimedTokens(address token, address backer) view returns (bool)",
  "function claimTokens(address token)",
]);

/** EIP-1167 implementations of VibesTranchEscrow, keyed by `chainId:lowercaseImpl`. */
export const ESCROW_IMPLS: Record<string, { gen: "v1" | "v2"; label: string }> = {
  "8453:0xcbe7e9e13576838eb4b55d0793fd1cffc1dea43d": { gen: "v2", label: "VibesTranchEscrow v2 (eligibility registry)" },
  "8453:0xba886d9fe4b3d1a5cd276de9f379e8449abc202a": { gen: "v1", label: "VibesTranchEscrow v1 (TermsAcceptance signature)" },
  "4663:0xd579f67a951011b04f99baed3b315222f7099d44": { gen: "v2", label: "VibesTranchEscrow v2 (eligibility registry)" },
};

/** Per-chain Vibestarter surfaces the co-pilot reads (verified live 2026-11-07, see research §5.1). */
export const CHALLENGE_CHAIN_CONFIG: Record<8453 | 4663, { router: Address; eligibilityRegistry: Address }> = {
  8453: { router: "0x783a7DB4113DC35A87dA43319af3cA7E6428f4BC", eligibilityRegistry: "0x7862D45068fad3dA9746DFc88cbAEa42380AAe2e" },
  4663: { router: "0x27E2841AA1F20c4838A9FeDE650F6eA5561264eC", eligibilityRegistry: "0x66b74176F53d3081a87F75e10aD6cF554174Aef9" },
};

/** Trust-surface facts (labels only; every claim shown in the UI is re-read live). */
export const TRUST_SURFACE = {
  platformSafe: "0x3CFDbf58Ed6866cD45Fb8B273EBA32a6259fFee0" as Address,
  backendSigner: "0x51e8932F7b1c81d802bF1409f3762373aC8EEBf7" as Address,
};

export const SAFE_ABI = parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"]);

/** Storage layout used by the dry-run state overrides (verified by read-back in research §6.5; self-checked at run time). */
export const STORAGE_LAYOUT = {
  /** mapping(uint8 => uint256) trancheRequestedAt — base slot on v1 and v2. */
  trancheRequestedAtSlot: 26n,
  /** v2: eligibilityRegistry (low 20 bytes, high 12 bytes = uint96 maxRaiseTotal) · v1: trustedSigner (low 20 bytes). */
  gateSlot: 41n,
  /** VibesToken (OpenZeppelin ERC20) `_balances` mapping base slot. */
  tokenBalancesSlot: 2n,
} as const;

const ALL_ERRORS_ABI = [...ESCROW_CHALLENGE_COMMON_ABI, ...ESCROW_CHALLENGE_V1_ABI].filter((x) => x.type === "error") as Abi;

/** Plain-English meaning of every revert the co-pilot can predict or observe. */
export const REVERT_TEXT: Record<string, string> = {
  InvalidState: "The escrow is not in the Funded state, so challenges are closed.",
  NotEligible: "Wallet has no live Vibestarter eligibility credential (Starter Card attestation).",
  ChallengePending: "Another challenge is already pending adjudication.",
  InvalidTranche: "The kickstart tranche (0) and a completed schedule cannot be challenged.",
  TrancheAlreadyClaimed: "The founder already claimed this tranche.",
  TrancheAlreadyChallenged: "This tranche is already under challenge.",
  ChallengeCooldownActive: "This wallet filed a challenge in the last 7 days (per-challenger cooldown).",
  TrancheNotRequested: "The founder has not requested this tranche yet, so no 72-hour window is open.",
  ChallengeWindowClosed: "The 72-hour challenge window has closed.",
  InsufficientTokensToChallenge: "Wallet holds less than the required challenge bond.",
  SafeERC20FailedOperation: "Token transfer of the bond failed (missing approval?).",
  ERC20InsufficientAllowance: "The escrow is not approved to pull the bond.",
  ERC20InsufficientBalance: "Insufficient token balance for the bond transfer.",
  NoChallengeActive: "There is no pending challenge to support, oppose or adjudicate.",
  NotTokenHolder: "Only token holders can support or oppose a challenge.",
  AlreadyVoted: "This wallet already recorded that same vote.",
  NotAContributor: "This wallet did not contribute ETH to the raise.",
  AlreadyClaimed: "Refund already claimed.",
  OnlyAdmin: "Only the escrow admin can adjudicate.",
  InvalidNonce: "Terms signature nonce mismatch (Vibestarter-issued signature required).",
  SignatureExpired: "Terms signature expired (Vibestarter-issued signature required).",
  InvalidSignature: "Terms signature not from Vibestarter's signer.",
  ECDSAInvalidSignature: "Missing/invalid Vibestarter TermsAcceptance signature.",
  ECDSAInvalidSignatureLength: "Missing Vibestarter TermsAcceptance signature.",
  NoRedeemableSupply: "Redeemable supply is zero, freeze would divide by zero.",
};

/** Decode revert data from any escrow/ERC-20 call into `ErrorName(args)`. */
export function decodeRevertData(data: Hex | undefined | null): string | null {
  if (!data || data === "0x") return data === "0x" ? "empty revert" : null;
  try {
    const d = decodeErrorResult({ abi: ALL_ERRORS_ABI, data });
    const args = (d.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
    if (d.errorName === "Error") return `Error("${String(args[0] ?? "").slice(0, 120)}")`;
    return `${d.errorName}(${args.join(", ")})`;
  } catch {
    return `unknown error ${data.slice(0, 10)}`;
  }
}
