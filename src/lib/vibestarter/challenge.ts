import {
  type Abi,
  type Address,
  type ContractFunctionParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  parseEventLogs,
  type PublicClient,
} from "viem";
import { ERC20_ABI } from "@/lib/abis";
import { quoteExactIn } from "@/lib/amm-math";
import { errMsg } from "@/lib/engine/chain-utils";
import { CAMPAIGN_STATES, CHALLENGE_STATES } from "@/lib/engine/escrow";
import { discoverWethPool, readPool } from "@/lib/engine/pools";
import type { ChainId } from "@/lib/engine/types";
import { fetchCampaigns } from "@/lib/engine/vibestarter-api";
import { getLogsClientForChain, getPublicClientForChain, settle } from "@/lib/rpc";
import {
  CHALLENGE_CHAIN_CONFIG,
  decodeRevertData,
  ELIGIBILITY_REGISTRY_ABI,
  ESCROW_ADMIN_ABI,
  ESCROW_CHALLENGE_COMMON_ABI,
  ESCROW_CHALLENGE_V1_ABI,
  ESCROW_CHALLENGE_V2_ABI,
  ESCROW_IMPLS,
  REVERT_TEXT,
  ROUTER_CLAIM_ABI,
  SAFE_ABI,
  STORAGE_LAYOUT,
  TRUST_SURFACE,
} from "./challenge-abis";

/* ────────────────────────────────────────────────────────────────────────────
 * Types (all uint256 values are decimal strings — JSON/KV-safe)
 * ──────────────────────────────────────────────────────────────────────────── */

export type ChallengeGen = "v1" | "v2" | "unknown";
export type ChallengePhase =
  | "NOT_FUNDED"
  | "FAILED"
  | "AWAITING_UNLOCK"
  | "AWAITING_REQUEST"
  | "WINDOW_OPEN"
  | "CHALLENGE_PENDING"
  | "AWAITING_CLAIM"
  | "COMPLETED"
  | "FROZEN"
  | "REFUNDING";

export interface Verdict {
  ok: boolean;
  via: "wallet" | "vibestarter-deeplink";
  reason?: string;
  predictedRevert?: string;
  needsApproval?: boolean;
}

export interface ReadinessStep {
  id: string;
  label: string;
  /** Custom error the deployed contract reverts with when this check fails (contract order). */
  revert: string;
  status: "pass" | "fail" | "unknown";
  detail?: string;
}

export interface CopilotNextTranche {
  tranche: number;
  amountWei: string;
  unlockTime: number;
  requestedAt: number;
  windowEndsAt: number | null;
  thresholdBps: number;
  bond: string;
  bondEthSpot: string | null;
  bondEthExit: string | null;
  slashAtRisk: string;
  slashEthSpot: string | null;
  claimed: boolean;
  challenged: boolean;
}

export interface CopilotChallenge {
  seq: number;
  active: boolean;
  challenger: string;
  reason: string;
  bond: string;
  tranche: number;
  filedAt: number;
  deadline: number;
  state: number;
  stateLabel: string;
}

export interface CopilotVotes {
  support: number;
  oppose: number;
  supportWeight: string;
  opposeWeight: string;
  voters: { address: string; vote: 1 | 2; weight: string }[];
  scannedFromBlock: string;
  complete: boolean;
  unofficial: true;
  note: string;
}

export interface CopilotWallet {
  address: string;
  nativeBalance: string;
  balance: string;
  allowance: string;
  contribution: { amount: string; refundClaimed: boolean } | null;
  eligible: boolean | null;
  credential: { tier: number; issuedAt: number; expiresAt: number; attestor: string } | null;
  v1Nonce: string | null;
  lastChallengeTime: number;
  cooldownEndsAt: number | null;
  currentVote: 0 | 1 | 2;
  claimableTokens: string | null;
  hasClaimedTokens: boolean | null;
  canRaise: Verdict;
  canSupport: Verdict;
  canOppose: Verdict;
  canExpire: Verdict;
  canClaimRefund: Verdict;
  canClaimTokens: Verdict;
  raiseChecklist: ReadinessStep[];
  refundIfUpheldEstimateWei: string | null;
  shareOfRedeemableBps: number | null;
  /** Live eth_call of raiseChallenge / supportChallenge from this wallet: the contract's actual answer right now. */
  ethCallProbe: { raise: { ok: boolean; revert: string | null }; support: { ok: boolean; revert: string | null } } | null;
}

export interface CopilotBase {
  chainId: ChainId;
  escrow: string;
  gen: ChallengeGen;
  impl: string | null;
  implLabel: string | null;
  title: string | null;
  launchTx: string | null;
  vibestarterUrl: string;
  block: { number: string; timestamp: number };
  oracleTime: number;
  token: { address: string; symbol: string; decimals: number; totalSupply: string; spotEthPerToken: string | null; pool: string | null; poolKind: string | null };
  state: number;
  stateLabel: string;
  phase: ChallengePhase;
  phaseDetail: string;
  admin: string | null;
  adminIsContract: boolean | null;
  adminSafe: { threshold: number; owners: string[] } | null;
  gating: { kind: "eligibility-registry" | "terms-signature" | "disabled" | "unknown"; address: string | null };
  constants: { challengeWindow: number; adjudicationWindow: number; cooldown: number; slashBps: number; platformFeeBps: number | null; timeOracle: string | null };
  escrowEth: { balance: string; pendingPlatformFees: string | null; excessLiability: string | null };
  challengeSeq: number;
  next: CopilotNextTranche | null;
  challenge: CopilotChallenge | null;
  votes: CopilotVotes | null;
  upheldSnapshot: { frozenEthBalance: string; frozenTotalSupply: string; source: "eth_simulateV1"; block: string } | null;
  trust: { platformSafe: { address: string; threshold: number | null; owners: string[] } | null; backendSigner: string; termsSigner: string | null };
  /** Raise-readiness checks that do not depend on a wallet (contract order). */
  raiseChecklist: ReadinessStep[];
  notes: string[];
}

export interface CopilotReport extends CopilotBase {
  wallet?: CopilotWallet;
  fetchedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
const FUNDED = 3;
const FAILED = 4;
const NUM_MONTHLY = 6;
const PRECISION = 10n ** 18n;

const EVENTS_ABI = [...ESCROW_CHALLENGE_COMMON_ABI.filter((x) => x.type === "event"), ...ERC20_ABI.filter((x) => x.type === "event")] as Abi;

export { decodeRevertData, REVERT_TEXT };

function revertName(decoded: string | null): string | null {
  if (!decoded) return null;
  const m = decoded.match(/^([A-Za-z0-9_]+)\(/);
  return m ? m[1] : decoded;
}

const balSlot = (a: Address) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [a, STORAGE_LAYOUT.tokenBalancesSlot]));
const reqSlot = (t: number) => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }], [t, STORAGE_LAYOUT.trancheRequestedAtSlot]));
const GATE_SLOT = pad(numberToHex(STORAGE_LAYOUT.gateSlot), { size: 32 });

function implFromCode(code: Hex | undefined): string | null {
  // EIP-1167: 0x363d3d373d3d3d363d73 <20-byte impl> 5af43d82803e903d91602b57fd5bf3
  if (!code || code.length < 2 + 45 * 2) return null;
  const c = code.toLowerCase();
  if (!c.startsWith("0x363d3d373d3d3d363d73")) return null;
  return getAddress(`0x${c.slice(22, 62)}`);
}

function phaseOf(state: number, challengePending: boolean, next: CopilotNextTranche | null, now: number): { phase: ChallengePhase; detail: string } {
  if (state === 5) return { phase: "FROZEN", detail: "Campaign frozen by the admin (challenge upheld or abandoned). Founder vesting halted." };
  if (state === 6) return { phase: "REFUNDING", detail: "Refund merkle root set: holders can claim pro-rata ETH refunds." };
  if (state === 7) return { phase: "COMPLETED", detail: "All tranches claimed. Nothing left to challenge." };
  if (state === FAILED) return { phase: "FAILED", detail: "Raise failed: contributors can reclaim their ETH with claimContributorRefund()." };
  if (state !== FUNDED) return { phase: "NOT_FUNDED", detail: "Raise not funded yet: no tranche schedule, no challenges." };
  if (challengePending) return { phase: "CHALLENGE_PENDING", detail: "A challenge is pending: tranche payout is blocked until the admin rules or the adjudication window lapses." };
  if (!next) return { phase: "COMPLETED", detail: "All monthly tranches are past." };
  if (next.requestedAt > 0 && next.windowEndsAt && now < next.windowEndsAt) return { phase: "WINDOW_OPEN", detail: `Founder requested tranche ${next.tranche}: the 72-hour challenge window is OPEN.` };
  if (next.requestedAt > 0) return { phase: "AWAITING_CLAIM", detail: `Window for tranche ${next.tranche} elapsed without a challenge: founder can claim.` };
  if (next.unlockTime > now) return { phase: "AWAITING_UNLOCK", detail: `Tranche ${next.tranche} unlocks at its scheduled time; the founder must then request it, which opens a 72-hour window.` };
  return { phase: "AWAITING_REQUEST", detail: `Tranche ${next.tranche} is unlocked but not requested: no window is open until the founder calls requestTranche.` };
}

function no(reason: string, predictedRevert?: string): Verdict {
  return { ok: false, via: "wallet", reason, predictedRevert };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Escrow context (one multicall + a few point reads)
 * ──────────────────────────────────────────────────────────────────────────── */

interface EscrowCtx {
  chainId: ChainId;
  escrow: Address;
  client: PublicClient;
  blockNumber: bigint;
  blockTimestamp: number;
  now: number;
  gen: ChallengeGen;
  impl: string | null;
  token: Address;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  state: number;
  nextTranche: number;
  admin: Address | null;
  gateAddress: Address | null;
  challengeWindow: number;
  adjudicationWindow: number;
  cooldown: number;
  slashBps: number;
  platformFeeBps: number | null;
  timeOracle: string | null;
  escrowBalance: bigint;
  pendingPlatformFees: bigint | null;
  excessLiability: bigint | null;
  challengeSeq: bigint;
  challenge: { challenger: Address; reason: string; amount: bigint; tranche: bigint; timestamp: bigint; state: number } | null;
  next: {
    tranche: number;
    amount: bigint;
    unlockTime: number;
    requestedAt: number;
    claimed: boolean;
    challenged: boolean;
    thresholdBps: number;
    bond: bigint;
  } | null;
  /** threshold/bond for the next tranche index even when out of 1..6 (used by non-funded dry-runs). */
  rawBond: bigint;
}

async function loadCtx(chainId: ChainId, escrow: Address): Promise<EscrowCtx> {
  const client = getPublicClientForChain(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const E = ESCROW_CHALLENGE_COMMON_ABI;
  const contracts: ContractFunctionParameters[] = [
    { address: escrow, abi: E, functionName: "getCampaign" }, // 0
    { address: escrow, abi: E, functionName: "getActiveChallenge" }, // 1
    { address: escrow, abi: E, functionName: "challengeSeq" }, // 2
    { address: escrow, abi: E, functionName: "CHALLENGE_WINDOW" }, // 3
    { address: escrow, abi: ESCROW_CHALLENGE_V2_ABI, functionName: "ADJUDICATION_WINDOW" }, // 4
    { address: escrow, abi: E, functionName: "CHALLENGE_COOLDOWN" }, // 5
    { address: escrow, abi: E, functionName: "CHALLENGE_SLASH_BPS" }, // 6
    { address: escrow, abi: E, functionName: "admin" }, // 7
    { address: escrow, abi: ESCROW_CHALLENGE_V2_ABI, functionName: "eligibilityRegistry" }, // 8
    { address: escrow, abi: ESCROW_CHALLENGE_V1_ABI, functionName: "trustedSigner" }, // 9
    { address: escrow, abi: E, functionName: "getCurrentTime" }, // 10
    { address: escrow, abi: E, functionName: "getEscrowBalance" }, // 11
    { address: escrow, abi: E, functionName: "pendingPlatformFees" }, // 12
    { address: escrow, abi: E, functionName: "totalExcessRefundLiability" }, // 13
    { address: escrow, abi: E, functionName: "platformFeeBps" }, // 14
    { address: escrow, abi: E, functionName: "PLATFORM_FEE_BPS" }, // 15
    { address: escrow, abi: E, functionName: "timeOracle" }, // 16
  ];
  const [r, code] = await Promise.all([
    client.multicall({ allowFailure: true, blockNumber: latest.number, contracts }),
    client.getCode({ address: escrow, blockNumber: latest.number }).catch(() => undefined),
  ]);
  const ok = (i: number) => r[i]?.status === "success";
  const pick = <T,>(i: number, fallback: T): T => (ok(i) ? (r[i].result as T) : fallback);

  const campaign = pick<{ token: Address; nextTranche: number; state: number } | null>(0, null);
  if (!campaign) throw new Error("Address does not expose VibesTranchEscrow.getCampaign() on this chain");

  const impl = implFromCode(code);
  const known = impl ? ESCROW_IMPLS[`${chainId}:${impl.toLowerCase()}`] : undefined;
  const gen: ChallengeGen = ok(8) ? "v2" : ok(9) ? "v1" : known?.gen ?? "unknown";
  const challengeWindow = Number(pick<bigint>(3, 259_200n));
  const now = Number(pick<bigint>(10, latest.timestamp));
  const n = campaign.nextTranche;

  const token = getAddress(campaign.token);
  const per: ContractFunctionParameters[] = [
    { address: token, abi: ERC20_ABI, functionName: "totalSupply" },
    { address: token, abi: ERC20_ABI, functionName: "symbol" },
    { address: token, abi: ERC20_ABI, functionName: "decimals" },
    { address: escrow, abi: E, functionName: "getChallengeThreshold", args: [Math.min(n, 255)] },
    { address: escrow, abi: E, functionName: "trancheRequestedAt", args: [Math.min(n, 255)] },
    { address: escrow, abi: E, functionName: "trancheChallenged", args: [Math.min(n, 255)] },
    { address: escrow, abi: E, functionName: "trancheClaimed", args: [Math.min(n, 255)] },
    { address: escrow, abi: E, functionName: "getTrancheAmount", args: [Math.min(n, 255)] },
    { address: escrow, abi: E, functionName: "getTrancheUnlockTime", args: [Math.min(n, 255)] },
  ];
  const r2 = await client.multicall({ allowFailure: true, blockNumber: latest.number, contracts: per });
  const p2 = <T,>(i: number, fallback: T): T => (r2[i]?.status === "success" ? (r2[i].result as T) : fallback);
  const totalSupply = p2<bigint>(0, 0n);
  const thresholdBps = Number(p2<bigint>(3, 0n));
  const rawBond = (totalSupply * BigInt(thresholdBps)) / 10_000n;

  const ch = pick<{ challenger: Address; reason: string; amount: bigint; tranche: bigint; timestamp: bigint; state: number } | null>(1, null);
  const inSchedule = n >= 1 && n <= NUM_MONTHLY;
  return {
    chainId,
    escrow,
    client,
    blockNumber: latest.number,
    blockTimestamp: Number(latest.timestamp),
    now,
    gen,
    impl,
    token,
    symbol: String(p2<string>(1, "TOKEN")).slice(0, 24),
    decimals: Number(p2<number>(2, 18)),
    totalSupply,
    state: Number(campaign.state),
    nextTranche: n,
    admin: ok(7) ? getAddress(pick<Address>(7, ZERO)) : null,
    gateAddress: gen === "v2" ? getAddress(pick<Address>(8, ZERO)) : gen === "v1" ? getAddress(pick<Address>(9, ZERO)) : null,
    challengeWindow,
    adjudicationWindow: gen === "v2" ? Number(pick<bigint>(4, 604_800n)) : challengeWindow,
    cooldown: Number(pick<bigint>(5, 604_800n)),
    slashBps: Number(pick<bigint>(6, 2000n)),
    platformFeeBps: ok(14) ? Number(pick<bigint>(14, 0n)) : ok(15) ? Number(pick<bigint>(15, 0n)) : null,
    timeOracle: ok(16) ? getAddress(pick<Address>(16, ZERO)) : null,
    escrowBalance: pick<bigint>(11, 0n),
    pendingPlatformFees: ok(12) ? pick<bigint>(12, 0n) : null,
    excessLiability: ok(13) ? pick<bigint>(13, 0n) : null,
    challengeSeq: pick<bigint>(2, 0n),
    challenge: ch && ch.state !== 0 ? ch : null,
    next: inSchedule
      ? {
          tranche: n,
          amount: p2<bigint>(7, 0n),
          unlockTime: Number(p2<bigint>(8, 0n)),
          requestedAt: Number(p2<bigint>(4, 0n)),
          challenged: p2<boolean>(5, false),
          claimed: p2<boolean>(6, false),
          thresholdBps,
          bond: rawBond,
        }
      : null,
    rawBond,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Readiness predictions (mirror the contract's revert order exactly)
 * ──────────────────────────────────────────────────────────────────────────── */

interface WalletFacts {
  eligible: boolean | null;
  balance: bigint;
  allowance: bigint;
  lastChallengeTime: number;
  currentVote: 0 | 1 | 2;
  contribution: { amount: bigint; refundClaimed: boolean } | null;
  claimable: bigint | null;
  hasClaimed: boolean | null;
}

function raiseChecklist(c: EscrowCtx, w: WalletFacts | null): ReadinessStep[] {
  const steps: ReadinessStep[] = [];
  const push = (id: string, label: string, revert: string, status: ReadinessStep["status"], detail?: string) => steps.push({ id, label, revert, status, detail });
  const pending = c.challenge?.state === 1;
  push("state", "Escrow is in Funded state (3)", "InvalidState", c.state === FUNDED ? "pass" : "fail", `on-chain state ${c.state} (${CAMPAIGN_STATES[c.state] ?? "?"})`);
  if (c.gen === "v1") push("gate", "Vibestarter TermsAcceptance signature (EIP-712, backend-issued)", "ECDSAInvalidSignatureLength", "unknown", "Genesis (v1) escrow: only Vibestarter's backend can issue it. Continue on Vibestarter.");
  else push("gate", "Live eligibility credential (registry.isEligible)", "NotEligible", c.gateAddress === ZERO ? "pass" : w ? (w.eligible ? "pass" : "fail") : "unknown", c.gateAddress === ZERO ? "gating disabled on this escrow" : w ? undefined : "connect a wallet");
  push("pending", "No other challenge pending", "ChallengePending", pending ? "fail" : "pass");
  const n = c.nextTranche;
  push("tranche", "Target tranche is a monthly tranche (1-6)", "InvalidTranche", n >= 1 && n <= NUM_MONTHLY ? "pass" : "fail", `nextTranche = ${n}`);
  push("claimed", "Tranche not already claimed", "TrancheAlreadyClaimed", c.next ? (c.next.claimed ? "fail" : "pass") : "unknown");
  push("challenged", "Tranche not already challenged", "TrancheAlreadyChallenged", c.next ? (c.next.challenged ? "fail" : "pass") : "unknown");
  if (w) {
    const cdEnd = w.lastChallengeTime + c.cooldown;
    push("cooldown", "7-day challenger cooldown elapsed", "ChallengeCooldownActive", c.now < cdEnd ? "fail" : "pass", w.lastChallengeTime ? `last challenge ${w.lastChallengeTime}` : "never challenged");
  } else push("cooldown", "7-day challenger cooldown elapsed", "ChallengeCooldownActive", "unknown", "connect a wallet");
  push("requested", "Founder requested the tranche (opens the window)", "TrancheNotRequested", c.next ? (c.next.requestedAt > 0 ? "pass" : "fail") : "unknown", c.next?.requestedAt ? `requested at ${c.next.requestedAt}` : "not requested");
  const winEnd = c.next && c.next.requestedAt > 0 ? c.next.requestedAt + c.challengeWindow : null;
  push("window", "Inside the 72-hour window", "ChallengeWindowClosed", winEnd == null ? "unknown" : c.now < winEnd ? "pass" : "fail", winEnd ? `window ends ${winEnd}` : "no window open");
  if (w && c.next) push("bond", "Holds at least the bond", "InsufficientTokensToChallenge", w.balance >= c.next.bond ? "pass" : "fail");
  else push("bond", "Holds at least the bond", "InsufficientTokensToChallenge", "unknown", w ? undefined : "connect a wallet");
  if (w && c.next) push("allowance", "Escrow approved for the exact bond (added to the bundle automatically)", "SafeERC20FailedOperation", w.allowance >= c.next.bond ? "pass" : "unknown", w.allowance >= c.next.bond ? undefined : "approve(escrow, bond) will be batched before raiseChallenge");
  return steps;
}

function verdictFromChecklist(c: EscrowCtx, steps: ReadinessStep[], w: WalletFacts | null): Verdict {
  if (c.state !== FUNDED) return no(REVERT_TEXT.InvalidState, "InvalidState");
  if (c.gen === "v1") return { ok: false, via: "vibestarter-deeplink", predictedRevert: "ECDSAInvalidSignatureLength", reason: "Genesis (v1) escrow requires a Vibestarter-issued TermsAcceptance signature. Kestrel cannot mint it." };
  if (c.gen === "unknown") return no("Unrecognized escrow implementation: Kestrel will not build a transaction for it.");
  const firstFail = steps.find((s) => s.status === "fail" && s.id !== "allowance");
  if (firstFail) return no(REVERT_TEXT[firstFail.revert] ?? firstFail.label, firstFail.revert);
  if (!w || !c.next) return no("Connect a wallet to evaluate eligibility, cooldown and bond.");
  return { ok: true, via: "wallet", needsApproval: w.allowance < c.next.bond };
}

function voteVerdict(c: EscrowCtx, w: WalletFacts, direction: 1 | 2): Verdict {
  if (c.state !== FUNDED) return no(REVERT_TEXT.InvalidState, "InvalidState");
  if (c.gen === "v1") return { ok: false, via: "vibestarter-deeplink", predictedRevert: "ECDSAInvalidSignatureLength", reason: "Genesis (v1) escrow: support/oppose need a Vibestarter-issued TermsAcceptance signature." };
  if (c.gen === "unknown") return no("Unrecognized escrow implementation.");
  if (c.gateAddress !== ZERO && !w.eligible) return no(REVERT_TEXT.NotEligible, "NotEligible");
  if (c.challenge?.state !== 1) return no(REVERT_TEXT.NoChallengeActive, "NoChallengeActive");
  if (w.balance === 0n) return no(REVERT_TEXT.NotTokenHolder, "NotTokenHolder");
  if (w.currentVote === direction) return no(REVERT_TEXT.AlreadyVoted, "AlreadyVoted");
  return { ok: true, via: "wallet" };
}

function expireVerdict(c: EscrowCtx): Verdict {
  if (c.challenge?.state !== 1) return no("No pending challenge: expireChallengeIfNeeded() would be a no-op.");
  const due = Number(c.challenge.timestamp) + c.adjudicationWindow;
  if (c.now <= due) return no(`Adjudication window runs until ${new Date(due * 1000).toISOString().slice(0, 16)}Z: expiring now would be a no-op.`);
  return { ok: true, via: "wallet" };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Report
 * ──────────────────────────────────────────────────────────────────────────── */

async function spotPrice(c: EscrowCtx): Promise<{ pool: string | null; kind: string | null; ethPerToken18: bigint | null; reserveToken: bigint | null; reserveWeth: bigint | null; feeBps: number }> {
  const empty = { pool: null, kind: null, ethPerToken18: null, reserveToken: null, reserveWeth: null, feeBps: 30 };
  const poolAddr = await settle(discoverWethPool(c.chainId, c.token));
  if (!poolAddr) return empty;
  const pool = await settle(readPool(c.chainId, poolAddr, { overnight: false }));
  if (!pool) return { ...empty, pool: poolAddr };
  const tokenIs0 = pool.token0.address.toLowerCase() === c.token.toLowerCase();
  const ethPerToken18 = BigInt(tokenIs0 ? pool.token1PerToken0 : pool.token0PerToken1);
  return {
    pool: poolAddr,
    kind: pool.kind,
    ethPerToken18: ethPerToken18 > 0n ? ethPerToken18 : null,
    reserveToken: BigInt(tokenIs0 ? pool.reserve0 : pool.reserve1),
    reserveWeth: BigInt(tokenIs0 ? pool.reserve1 : pool.reserve0),
    feeBps: pool.feeBps,
  };
}

async function readVotes(c: EscrowCtx): Promise<CopilotVotes | null> {
  if (c.challenge?.state !== 1) return null;
  const logsClient = getLogsClientForChain(c.chainId);
  const seq = c.challengeSeq;
  const age = Math.max(0, c.blockTimestamp - Number(c.challenge.timestamp));
  // Estimate the filing block from the live block time (Base: 200 ms blocks since 2026-11-05).
  const past = await c.client.getBlock({ blockNumber: c.blockNumber > 10_000n ? c.blockNumber - 10_000n : 0n });
  const bt = Math.max(0.05, (c.blockTimestamp - Number(past.timestamp)) / 10_000);
  const back = BigInt(Math.ceil((age / bt) * 1.05)) + 1_000n;
  const filedBlock = c.blockNumber > back ? c.blockNumber - back : 0n;
  const CHUNK = 49_000n;
  const MAX_CHUNKS = c.chainId === 4663 ? 1 : 12;
  const logs: { address: Address; eventName: string; args: Record<string, unknown> }[] = [];
  let from = filedBlock;
  let complete = true;
  if (c.chainId === 4663) {
    // Robinhood Chain allows unfiltered address queries over large ranges; decode locally.
    const raw = await logsClient.getLogs({ address: c.escrow, fromBlock: filedBlock, toBlock: c.blockNumber });
    logs.push(...(parseEventLogs({ abi: EVENTS_ABI, logs: raw }) as unknown as typeof logs));
  } else {
    let to = c.blockNumber;
    let chunks = 0;
    while (to >= filedBlock && chunks < MAX_CHUNKS) {
      const f = to - CHUNK + 1n > filedBlock ? to - CHUNK + 1n : filedBlock;
      const raw = await logsClient.getLogs({ address: c.escrow, fromBlock: f, toBlock: to });
      logs.push(...(parseEventLogs({ abi: EVENTS_ABI, logs: raw }) as unknown as typeof logs));
      from = f;
      to = f - 1n;
      chunks++;
    }
    complete = from <= filedBlock;
  }
  const voters = [
    ...new Set(
      logs
        .filter((l) => l.eventName === "ChallengeSupported" || l.eventName === "ChallengeOpposed")
        .map((l) => String((l.args.supporter ?? l.args.opposer) as string).toLowerCase())
    ),
  ].map((a) => getAddress(a));
  const reads = await c.client.multicall({
    allowFailure: true,
    blockNumber: c.blockNumber,
    contracts: voters.flatMap((v): ContractFunctionParameters[] => [
      { address: c.escrow, abi: ESCROW_CHALLENGE_COMMON_ABI, functionName: "challengeVoteBySeq", args: [seq, v] },
      { address: c.token, abi: ERC20_ABI, functionName: "balanceOf", args: [v] },
    ]),
  });
  const out: CopilotVotes["voters"] = [];
  let sw = 0n;
  let ow = 0n;
  voters.forEach((v, i) => {
    const vote = reads[i * 2]?.status === "success" ? Number(reads[i * 2].result) : 0;
    const bal = reads[i * 2 + 1]?.status === "success" ? (reads[i * 2 + 1].result as bigint) : 0n;
    if (vote === 1) sw += bal;
    if (vote === 2) ow += bal;
    if (vote === 1 || vote === 2) out.push({ address: v, vote, weight: bal.toString() });
  });
  return {
    support: out.filter((x) => x.vote === 1).length,
    oppose: out.filter((x) => x.vote === 2).length,
    supportWeight: sw.toString(),
    opposeWeight: ow.toString(),
    voters: out.slice(0, 50),
    scannedFromBlock: (c.chainId === 4663 ? filedBlock : from).toString(),
    complete,
    unofficial: true,
    note: "Unofficial: the contract does not count votes or weigh them; the admin adjudicates. Weight = current token balance; final direction = challengeVoteBySeq.",
  };
}

async function buildBase(chainId: ChainId, escrow: Address): Promise<CopilotBase> {
  const c = await loadCtx(chainId, escrow);
  const notes: string[] = [];
  const [price, adminCode, safeInfo, campaigns, upheld, votes] = await Promise.all([
    spotPrice(c),
    c.admin ? settle(c.client.getCode({ address: c.admin })) : Promise.resolve(null),
    chainId === 8453
      ? settle(
          getPublicClientForChain(8453).multicall({
            allowFailure: true,
            contracts: [
              { address: TRUST_SURFACE.platformSafe, abi: SAFE_ABI, functionName: "getOwners" },
              { address: TRUST_SURFACE.platformSafe, abi: SAFE_ABI, functionName: "getThreshold" },
            ],
          })
        )
      : Promise.resolve(null),
    fetchCampaigns(),
    c.state === FUNDED && c.gen !== "unknown" && c.next ? settle(upholdSnapshot(c)) : Promise.resolve(null),
    settle(readVotes(c)),
  ]);
  const adminIsContract = c.admin ? (adminCode && adminCode !== "0x" ? true : adminCode === null ? null : false) : null;
  let adminSafe: CopilotBase["adminSafe"] = null;
  if (adminIsContract && c.admin) {
    const s = await settle(
      c.client.multicall({
        allowFailure: true,
        contracts: [
          { address: c.admin, abi: SAFE_ABI, functionName: "getOwners" },
          { address: c.admin, abi: SAFE_ABI, functionName: "getThreshold" },
        ],
      })
    );
    if (s && s[0].status === "success" && s[1].status === "success") adminSafe = { owners: [...s[0].result], threshold: Number(s[1].result) };
  }

  const api = campaigns.find((x) => x.escrowAddress?.toLowerCase() === escrow.toLowerCase() && x.chainId === chainId) ?? null;
  const launchTx = ((api?.token as { launchTxHash?: string } | null)?.launchTxHash ?? null) as string | null;
  const isGenesis = c.gen === "v1";
  const vibestarterUrl = isGenesis ? "https://app.vibestarter.xyz/raises/vibes" : launchTx && /^0x[0-9a-fA-F]{64}$/.test(launchTx) ? `https://app.vibestarter.xyz/raises/${launchTx}` : "https://app.vibestarter.xyz";

  const scale = 10n ** BigInt(c.decimals);
  const toEth = (amt: bigint) => (price.ethPerToken18 ? ((amt * price.ethPerToken18) / scale).toString() : null);
  let next: CopilotNextTranche | null = null;
  if (c.next) {
    const slash = (c.next.bond * BigInt(c.slashBps)) / 10_000n;
    const exit = price.reserveToken && price.reserveWeth && price.kind === "aerodrome-v2" ? quoteExactIn(c.next.bond, price.reserveToken, price.reserveWeth, price.feeBps).toString() : null;
    next = {
      tranche: c.next.tranche,
      amountWei: c.next.amount.toString(),
      unlockTime: c.next.unlockTime,
      requestedAt: c.next.requestedAt,
      windowEndsAt: c.next.requestedAt > 0 ? c.next.requestedAt + c.challengeWindow : null,
      thresholdBps: c.next.thresholdBps,
      bond: c.next.bond.toString(),
      bondEthSpot: toEth(c.next.bond),
      bondEthExit: exit,
      slashAtRisk: slash.toString(),
      slashEthSpot: toEth(slash),
      claimed: c.next.claimed,
      challenged: c.next.challenged,
    };
  }
  if (!price.ethPerToken18 && c.next) notes.push("Spot price unavailable: no readable WETH pool for this token, so ETH values of the bond are not shown.");
  if (price.kind === "uniswap-v3") notes.push("Bond exit value omitted: concentrated-liquidity exits can cross ticks; only the spot value is shown.");

  const pending = c.challenge?.state === 1;
  const challenge: CopilotChallenge | null = c.challenge
    ? {
        seq: Number(c.challengeSeq),
        active: pending,
        challenger: c.challenge.challenger,
        reason: c.challenge.reason.slice(0, 2000),
        bond: c.challenge.amount.toString(),
        tranche: Number(c.challenge.tranche),
        filedAt: Number(c.challenge.timestamp),
        deadline: Number(c.challenge.timestamp) + c.adjudicationWindow,
        state: c.challenge.state,
        stateLabel: CHALLENGE_STATES[c.challenge.state] ?? String(c.challenge.state),
      }
    : null;
  const { phase, detail } = phaseOf(c.state, pending, next, c.now);
  if (c.gen === "unknown") notes.push("Escrow implementation not recognized (neither eligibilityRegistry() nor trustedSigner()); write actions disabled.");
  if (Number(c.challengeSeq) === 0) notes.push("No challenge has ever been filed on this escrow (challengeSeq = 0).");

  return {
    chainId,
    escrow,
    gen: c.gen,
    impl: c.impl,
    implLabel: c.impl ? ESCROW_IMPLS[`${chainId}:${c.impl.toLowerCase()}`]?.label ?? "unrecognized implementation" : null,
    title: api?.title ?? (isGenesis ? "Vibestarter" : null),
    launchTx,
    vibestarterUrl,
    block: { number: c.blockNumber.toString(), timestamp: c.blockTimestamp },
    oracleTime: c.now,
    token: { address: c.token, symbol: c.symbol, decimals: c.decimals, totalSupply: c.totalSupply.toString(), spotEthPerToken: price.ethPerToken18?.toString() ?? null, pool: price.pool, poolKind: price.kind },
    state: c.state,
    stateLabel: CAMPAIGN_STATES[c.state] ?? `Unknown(${c.state})`,
    phase,
    phaseDetail: detail,
    admin: c.admin,
    adminIsContract,
    adminSafe,
    gating: {
      kind: c.gen === "v2" ? (c.gateAddress === ZERO ? "disabled" : "eligibility-registry") : c.gen === "v1" ? (c.gateAddress === ZERO ? "disabled" : "terms-signature") : "unknown",
      address: c.gateAddress,
    },
    constants: { challengeWindow: c.challengeWindow, adjudicationWindow: c.adjudicationWindow, cooldown: c.cooldown, slashBps: c.slashBps, platformFeeBps: c.platformFeeBps, timeOracle: c.timeOracle },
    escrowEth: { balance: c.escrowBalance.toString(), pendingPlatformFees: c.pendingPlatformFees?.toString() ?? null, excessLiability: c.excessLiability?.toString() ?? null },
    challengeSeq: Number(c.challengeSeq),
    next,
    challenge,
    votes,
    upheldSnapshot: upheld,
    trust: {
      platformSafe:
        safeInfo && safeInfo[0].status === "success"
          ? { address: TRUST_SURFACE.platformSafe, owners: [...(safeInfo[0].result as readonly Address[])], threshold: safeInfo[1].status === "success" ? Number(safeInfo[1].result) : null }
          : null,
      backendSigner: TRUST_SURFACE.backendSigner,
      termsSigner: c.gen === "v1" ? c.gateAddress : null,
    },
    raiseChecklist: raiseChecklist(c, null),
    notes,
  };
}

async function readWallet(c: EscrowCtx, base: CopilotBase, wallet: Address): Promise<CopilotWallet> {
  const cfg = CHALLENGE_CHAIN_CONFIG[c.chainId];
  const E = ESCROW_CHALLENGE_COMMON_ABI;
  const registry = c.gen === "v2" && c.gateAddress && c.gateAddress !== ZERO ? c.gateAddress : null;
  const contracts: ContractFunctionParameters[] = [
    { address: c.token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }, // 0
    { address: c.token, abi: ERC20_ABI, functionName: "allowance", args: [wallet, c.escrow] }, // 1
    { address: c.escrow, abi: E, functionName: "getContribution", args: [wallet] }, // 2
    { address: c.escrow, abi: E, functionName: "lastChallengeTime", args: [wallet] }, // 3
    { address: c.escrow, abi: E, functionName: "challengeVoteBySeq", args: [c.challengeSeq, wallet] }, // 4
    { address: cfg.router, abi: ROUTER_CLAIM_ABI, functionName: "getClaimableTokens", args: [c.token, wallet] }, // 5
    { address: cfg.router, abi: ROUTER_CLAIM_ABI, functionName: "hasClaimedTokens", args: [c.token, wallet] }, // 6
    ...(registry
      ? ([
          { address: registry, abi: ELIGIBILITY_REGISTRY_ABI, functionName: "isEligible", args: [wallet] }, // 7
          { address: registry, abi: ELIGIBILITY_REGISTRY_ABI, functionName: "credentialOf", args: [wallet] }, // 8
        ] as ContractFunctionParameters[])
      : c.gen === "v1"
        ? ([{ address: c.escrow, abi: ESCROW_CHALLENGE_V1_ABI, functionName: "nonces", args: [wallet] }] as ContractFunctionParameters[]) // 7
        : []),
  ];
  const [r, nativeBalance] = await Promise.all([
    c.client.multicall({ allowFailure: true, blockNumber: c.blockNumber, contracts }),
    c.client.getBalance({ address: wallet }).catch(() => 0n),
  ]);
  const ok = (i: number) => r[i]?.status === "success";
  const pick = <T,>(i: number, fallback: T): T => (ok(i) ? (r[i].result as T) : fallback);
  const contrib = pick<{ amount: bigint; refundClaimed: boolean } | null>(2, null);
  const cred = registry ? pick<{ attestor: Address; issuedAt: number; expiresAt: number; tier: number } | null>(8, null) : null;
  const facts: WalletFacts = {
    eligible: registry ? (ok(7) ? Boolean(r[7].result) : null) : c.gen === "v2" ? true : null,
    balance: pick<bigint>(0, 0n),
    allowance: pick<bigint>(1, 0n),
    lastChallengeTime: Number(pick<bigint>(3, 0n)),
    currentVote: (Number(pick<number>(4, 0)) as 0 | 1 | 2) ?? 0,
    contribution: contrib ? { amount: contrib.amount, refundClaimed: contrib.refundClaimed } : null,
    claimable: ok(5) ? pick<bigint>(5, 0n) : null,
    hasClaimed: ok(6) ? pick<boolean>(6, false) : null,
  };
  const steps = raiseChecklist(c, facts);
  const canRaise = verdictFromChecklist(c, steps, facts);
  const ethCallProbe = c.gen === "unknown" ? null : await probeCalls(c, wallet);

  let canClaimRefund: Verdict;
  if (c.state !== FAILED) canClaimRefund = no(`claimContributorRefund() is only open in Failed state (escrow is ${CAMPAIGN_STATES[c.state] ?? c.state}).`, "InvalidState");
  else if (!facts.contribution || facts.contribution.amount === 0n) canClaimRefund = no(REVERT_TEXT.NotAContributor, "NotAContributor");
  else if (facts.contribution.refundClaimed) canClaimRefund = no(REVERT_TEXT.AlreadyClaimed, "AlreadyClaimed");
  else canClaimRefund = { ok: true, via: "wallet" };

  let canClaimTokens: Verdict;
  if (facts.claimable === null) canClaimTokens = no("Router claim view unavailable on this chain.");
  else if (facts.hasClaimed) canClaimTokens = no("Backer tokens already claimed from the launch router.");
  else if (facts.claimable === 0n) canClaimTokens = no("No claimable backer tokens for this wallet.");
  else canClaimTokens = { ok: true, via: "wallet" };

  let refundIfUpheldEstimateWei: string | null = null;
  let shareOfRedeemableBps: number | null = null;
  if (base.upheldSnapshot) {
    const fe = BigInt(base.upheldSnapshot.frozenEthBalance);
    const fs = BigInt(base.upheldSnapshot.frozenTotalSupply);
    if (fs > 0n) {
      refundIfUpheldEstimateWei = ((facts.balance * fe) / fs).toString();
      shareOfRedeemableBps = Number((facts.balance * 10_000n * PRECISION) / fs / PRECISION);
    }
  }
  return {
    address: wallet,
    nativeBalance: nativeBalance.toString(),
    balance: facts.balance.toString(),
    allowance: facts.allowance.toString(),
    contribution: facts.contribution ? { amount: facts.contribution.amount.toString(), refundClaimed: facts.contribution.refundClaimed } : null,
    eligible: facts.eligible,
    credential: cred && cred.attestor !== ZERO ? { tier: Number(cred.tier), issuedAt: Number(cred.issuedAt), expiresAt: Number(cred.expiresAt), attestor: cred.attestor } : null,
    v1Nonce: c.gen === "v1" && ok(7) ? String(r[7].result) : null,
    lastChallengeTime: facts.lastChallengeTime,
    cooldownEndsAt: facts.lastChallengeTime ? facts.lastChallengeTime + c.cooldown : null,
    currentVote: facts.currentVote,
    claimableTokens: facts.claimable?.toString() ?? null,
    hasClaimedTokens: facts.hasClaimed,
    canRaise,
    canSupport: voteVerdict(c, facts, 1),
    canOppose: voteVerdict(c, facts, 2),
    canExpire: expireVerdict(c),
    canClaimRefund,
    canClaimTokens,
    raiseChecklist: steps,
    refundIfUpheldEstimateWei,
    shareOfRedeemableBps,
    ethCallProbe,
  };
}

function revertDataOf(e: unknown): Hex | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x")) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return (d as { data: Hex }).data;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** eth_call the real challenge entrypoints from the wallet (nothing is signed) to confirm the predicted revert. */
async function probeCalls(c: EscrowCtx, wallet: Address): Promise<CopilotWallet["ethCallProbe"]> {
  const isV1 = c.gen === "v1";
  const deadline = BigInt(c.blockTimestamp + 600);
  const W = isV1 ? ESCROW_CHALLENGE_V1_ABI : ESCROW_CHALLENGE_V2_ABI;
  const one = async (fn: "raiseChallenge" | "supportChallenge") => {
    const data = encodeFunctionData({ abi: W, functionName: fn, args: (isV1 ? ["Kestrel readiness probe", 0n, deadline, "0x"] : ["Kestrel readiness probe"]) as never } as Parameters<typeof encodeFunctionData>[0]);
    try {
      await c.client.call({ account: wallet, to: c.escrow, data, blockNumber: c.blockNumber });
      return { ok: true, revert: null };
    } catch (e) {
      return { ok: false, revert: decodeRevertData(revertDataOf(e)) ?? errMsg(e) };
    }
  };
  const [raise, support] = await Promise.all([one("raiseChallenge"), one("supportChallenge")]);
  return { raise, support };
}

/**
 * Full Backer Challenge Co-pilot report for one escrow. `base` (wallet-independent) may come from a cache;
 * wallet reads are always live.
 */
export async function readChallengeCopilot(
  chainId: ChainId,
  escrow: Address,
  opts: { wallet?: Address | null; base?: CopilotBase } = {}
): Promise<CopilotReport> {
  const base = opts.base ?? (await buildBase(chainId, escrow));
  if (!opts.wallet) return { ...base, fetchedAt: new Date().toISOString() };
  const c = await loadCtx(chainId, escrow);
  const wallet = await readWallet(c, base, opts.wallet);
  return { ...base, raiseChecklist: wallet.raiseChecklist, wallet, fetchedAt: new Date().toISOString() };
}

export { buildBase as buildChallengeBase };

/* ────────────────────────────────────────────────────────────────────────────
 * Challenge Dry-Run — eth_simulateV1 runs the REAL deployed escrow code
 * ──────────────────────────────────────────────────────────────────────────── */

export type DryRunOutcome = "raise" | "reject" | "uphold" | "expire";
export const DRY_RUN_OUTCOMES: DryRunOutcome[] = ["raise", "reject", "uphold", "expire"];

/** Synthetic actors ("KESTREL" in ASCII) — no real person is involved in any dry-run. */
export const DRY_RUN_ACTORS = {
  challenger: "0x4b45535452454c00000000000000000000000001" as Address,
  supporter: "0x4b45535452454c00000000000000000000000002" as Address,
  opposer: "0x4b45535452454c00000000000000000000000003" as Address,
};

export interface DryRunStep {
  block: number;
  label: string;
  actor: string;
  actorLabel: string;
  call: string;
  kind: "check" | "action" | "read";
  status: "success" | "failure";
  expectFailure: boolean;
  gasUsed: string | null;
  decoded: string | null;
  revert: string | null;
  revertText: string | null;
  events: string[];
}

export interface DryRunScenario {
  outcome: DryRunOutcome;
  title: string;
  summary: string;
  ok: boolean;
  steps: DryRunStep[];
  facts: { label: string; value: string }[];
  error?: string;
}

export interface DryRunOverride {
  address: string;
  slot: string;
  value: string;
  why: string;
}

export interface DryRunResult {
  chainId: ChainId;
  escrow: string;
  gen: ChallengeGen;
  applicable: boolean;
  reason: string | null;
  block: { number: string; timestamp: number };
  token: { address: string; symbol: string; decimals: number };
  nextTranche: number;
  bond: string;
  slash: string;
  admin: string | null;
  actors: typeof DRY_RUN_ACTORS;
  overrides: DryRunOverride[];
  selfCheck: "ok" | "layout-mismatch" | "not-run";
  selfCheckDetail: string;
  scenarios: DryRunScenario[];
  elapsedMs: number;
  method: "eth_simulateV1";
  disclaimer: string;
}

interface SimCall {
  label: string;
  actor: Address;
  actorLabel: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  kind: DryRunStep["kind"];
  expectFailure?: boolean;
}

interface SimBlock {
  time?: bigint;
  calls: SimCall[];
}

function encodeCall(c: SimCall): Hex {
  return encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as Parameters<typeof encodeFunctionData>[0]);
}

function fmtVal(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map(fmtVal).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${fmtVal(x)}`).join(", ")}}`;
  return String(v);
}

async function simulate(
  c: EscrowCtx,
  overrides: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[],
  blocks: SimBlock[]
): Promise<{ steps: DryRunStep[]; results: unknown[][] }> {
  const client = getLogsClientForChain(c.chainId);
  const res = await client.simulateBlocks({
    blockNumber: c.blockNumber,
    blocks: blocks.map((b, i) => ({
      ...(i === 0 ? { stateOverrides: overrides } : {}),
      ...(b.time !== undefined ? { blockOverrides: { time: b.time } } : {}),
      calls: b.calls.map((x) => ({ account: x.actor, to: x.to, data: encodeCall(x) })),
    })),
  });
  const steps: DryRunStep[] = [];
  const results: unknown[][] = [];
  res.forEach((blk, bi) => {
    const row: unknown[] = [];
    blk.calls.forEach((call, ci) => {
      const spec = blocks[bi].calls[ci];
      const data = (call as { data?: Hex }).data;
      let decodedResult: unknown = undefined;
      if (call.status === "success" && data && data !== "0x" && spec.kind !== "action") {
        try {
          decodedResult = decodeFunctionResult({ abi: spec.abi, functionName: spec.functionName, data } as Parameters<typeof decodeFunctionResult>[0]);
        } catch {
          decodedResult = undefined;
        }
      }
      row.push(decodedResult);
      const decodedRevert = call.status === "failure" ? decodeRevertData(data) : null;
      let events: string[] = [];
      const logs = (call as { logs?: { address: Address; topics: Hex[]; data: Hex }[] }).logs ?? [];
      if (logs.length) {
        try {
          events = parseEventLogs({ abi: EVENTS_ABI, logs: logs as Parameters<typeof parseEventLogs>[0]["logs"] }).map((l) => {
            const a = (l as unknown as { args: Record<string, unknown> }).args ?? {};
            return `${(l as unknown as { eventName: string }).eventName}(${Object.entries(a)
              .map(([k, v]) => `${k}: ${fmtVal(v).slice(0, 80)}`)
              .join(", ")})`;
          });
        } catch {
          events = [];
        }
      }
      steps.push({
        block: bi + 1,
        label: spec.label,
        actor: spec.actor,
        actorLabel: spec.actorLabel,
        call: `${spec.functionName}(${(spec.args ?? []).map((a) => (typeof a === "string" && a.length > 42 ? `"${a.slice(0, 40)}…"` : typeof a === "string" && !a.startsWith("0x") ? `"${a}"` : fmtVal(a))).join(", ")})`,
        kind: spec.kind,
        status: call.status,
        expectFailure: !!spec.expectFailure,
        gasUsed: call.gasUsed !== undefined ? call.gasUsed.toString() : null,
        decoded: decodedResult !== undefined ? fmtVal(decodedResult).slice(0, 400) : null,
        revert: decodedRevert,
        revertText: decodedRevert ? REVERT_TEXT[revertName(decodedRevert) ?? ""] ?? null : null,
        events,
      });
    });
    results.push(row);
  });
  return { steps, results };
}

/** Uphold snapshot from the real contract code: what frozenEthBalance / frozenTotalSupply would be if a challenge were upheld now. */
async function upholdSnapshot(c: EscrowCtx): Promise<CopilotBase["upheldSnapshot"]> {
  const r = await runScenarios(c, ["uphold"]);
  const sc = r.scenarios[0];
  if (!sc?.ok || r.selfCheck !== "ok") return null;
  const fe = sc.facts.find((f) => f.label === "frozenEthBalance")?.value;
  const fs = sc.facts.find((f) => f.label === "frozenTotalSupply")?.value;
  if (!fe || !fs) return null;
  return { frozenEthBalance: fe, frozenTotalSupply: fs, source: "eth_simulateV1", block: c.blockNumber.toString() };
}

async function runScenarios(c: EscrowCtx, outcomes: DryRunOutcome[]): Promise<DryRunResult> {
  const t0 = Date.now();
  const { challenger: S, supporter: S2, opposer: S3 } = DRY_RUN_ACTORS;
  const E = ESCROW_CHALLENGE_COMMON_ABI;
  const isV1 = c.gen === "v1";
  const W = isV1 ? ESCROW_CHALLENGE_V1_ABI : ESCROW_CHALLENGE_V2_ABI;
  const ABI_W = [...W, ...E] as Abi;
  const nowB = BigInt(c.blockTimestamp);
  const sigArgs = (text: string): readonly unknown[] => (isV1 ? [text, 0n, nowB + 3600n, "0x"] : [text]);
  const realPending = c.challenge?.state === 1;
  const challengerAddr = realPending ? getAddress(c.challenge!.challenger) : S;
  const t = Math.min(Math.max(c.nextTranche, 0), 255);
  const bond = c.next?.bond ?? c.rawBond;
  const slash = (bond * BigInt(c.slashBps)) / 10_000n;
  const oneToken = 10n ** BigInt(c.decimals);

  const base: Omit<DryRunResult, "scenarios" | "selfCheck" | "selfCheckDetail" | "elapsedMs" | "overrides" | "applicable" | "reason"> = {
    chainId: c.chainId,
    escrow: c.escrow,
    gen: c.gen,
    block: { number: c.blockNumber.toString(), timestamp: c.blockTimestamp },
    token: { address: c.token, symbol: c.symbol, decimals: c.decimals },
    nextTranche: c.nextTranche,
    bond: bond.toString(),
    slash: slash.toString(),
    admin: c.admin,
    actors: DRY_RUN_ACTORS,
    method: "eth_simulateV1",
    disclaimer: "Simulation of the deployed contract code at the current block with the storage slots listed below overridden. Synthetic actors only. Admin rulings are impersonated inside eth_simulateV1 purely to show each outcome; they say nothing about how the real admin would rule. Nothing is signed or sent.",
  };

  if (c.gen === "unknown") {
    return { ...base, applicable: false, reason: "Unrecognized escrow implementation: dry-run disabled.", overrides: [], selfCheck: "not-run", selfCheckDetail: "", scenarios: [], elapsedMs: Date.now() - t0 };
  }

  // Pre-check: the gate slot must hold the gate address we read via its getter, else the layout differs.
  const rawGate = (await c.client.getStorageAt({ address: c.escrow, slot: GATE_SLOT, blockNumber: c.blockNumber })) ?? pad("0x0", { size: 32 });
  const gateInSlot = getAddress(`0x${rawGate.slice(-40)}`);
  if (c.gateAddress && gateInSlot.toLowerCase() !== c.gateAddress.toLowerCase()) {
    return {
      ...base,
      applicable: false,
      reason: "Storage layout check failed: refusing to run overrides on an unexpected layout.",
      overrides: [],
      selfCheck: "layout-mismatch",
      selfCheckDetail: `slot ${STORAGE_LAYOUT.gateSlot} low 20 bytes = ${gateInSlot}, getter = ${c.gateAddress}`,
      scenarios: [],
      elapsedMs: Date.now() - t0,
    };
  }
  const noGate = `${rawGate.slice(0, 26)}${"0".repeat(40)}` as Hex;

  const overrideList: DryRunOverride[] = [];
  const tokenDiff: { slot: Hex; value: Hex }[] = [];
  const escrowDiff: { slot: Hex; value: Hex }[] = [];
  if (!realPending) {
    tokenDiff.push({ slot: balSlot(S), value: numberToHex(bond, { size: 32 }) });
    overrideList.push({ address: c.token, slot: balSlot(S), value: bond.toString(), why: `${c.symbol}._balances[challenger] = exact bond (synthetic challenger)` });
  }
  tokenDiff.push({ slot: balSlot(S2), value: numberToHex(oneToken, { size: 32 }) }, { slot: balSlot(S3), value: numberToHex(oneToken, { size: 32 }) });
  overrideList.push({ address: c.token, slot: balSlot(S2), value: oneToken.toString(), why: `${c.symbol}._balances[supporter] = 1 token (holder requirement)` });
  overrideList.push({ address: c.token, slot: balSlot(S3), value: oneToken.toString(), why: `${c.symbol}._balances[opposer] = 1 token (holder requirement)` });
  const requestedAt = nowB - 3600n;
  if (!realPending && c.next && c.next.requestedAt === 0) {
    escrowDiff.push({ slot: reqSlot(t), value: numberToHex(requestedAt, { size: 32 }) });
    overrideList.push({ address: c.escrow, slot: reqSlot(t), value: requestedAt.toString(), why: `trancheRequestedAt[${t}] = now - 1h (as if the founder requested the tranche: opens the 72h window)` });
  }
  if (c.gateAddress && c.gateAddress !== ZERO) {
    escrowDiff.push({ slot: GATE_SLOT, value: noGate });
    overrideList.push({
      address: c.escrow,
      slot: GATE_SLOT,
      value: noGate,
      why: isV1 ? "trustedSigner = 0 (contract's own 'gating disabled' path; real users need Vibestarter's signature)" : "eligibilityRegistry = 0 (contract's own 'gating disabled' path; real users need a credential). High 12 bytes (maxRaiseTotal) preserved",
    });
  }
  const overrides = [
    { address: c.token, stateDiff: tokenDiff },
    ...(escrowDiff.length ? [{ address: c.escrow, stateDiff: escrowDiff }] : []),
  ];

  const balOf = (who: Address, _role: string, label: string): SimCall => ({ label, actor: S2, actorLabel: "reader", to: c.token, abi: ERC20_ABI as Abi, functionName: "balanceOf", args: [who], kind: "read" });
  const selfChecks: SimCall[] = [
    { label: "Self-check: trancheRequestedAt reads back the override", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "trancheRequestedAt", args: [t], kind: "check" },
    { label: "Self-check: challenger balance reads back the override", actor: S2, actorLabel: "reader", to: c.token, abi: ERC20_ABI as Abi, functionName: "balanceOf", args: [challengerAddr], kind: "check" },
  ];
  const schedule0 = c.state === FUNDED && !!c.next;
  const raiseCalls: SimCall[] = realPending
    ? []
    : [
        { label: `Challenger approves the escrow for exactly the bond`, actor: S, actorLabel: "challenger", to: c.token, abi: ERC20_ABI as Abi, functionName: "approve", args: [c.escrow, bond], kind: "action" },
        { label: schedule0 ? `Challenger files raiseChallenge on tranche ${t}` : `Challenger attempts raiseChallenge (escrow state ${c.state})`, actor: S, actorLabel: "challenger", to: c.escrow, abi: ABI_W, functionName: "raiseChallenge", args: sigArgs("Kestrel dry-run: synthetic challenge, nothing is sent"), kind: "action" },
      ];
  const voteCalls: SimCall[] = [
    { label: "Holder B supports the challenge", actor: S2, actorLabel: "supporter", to: c.escrow, abi: ABI_W, functionName: "supportChallenge", args: sigArgs("dry-run support"), kind: "action" },
    { label: "Holder C opposes the challenge", actor: S3, actorLabel: "opposer", to: c.escrow, abi: ABI_W, functionName: "opposeChallenge", args: sigArgs("dry-run oppose"), kind: "action" },
  ];
  const seqNext = realPending ? c.challengeSeq : c.challengeSeq + 1n;
  const schedule = c.state === FUNDED && !!c.next;
  const raiseBlock = (extra: SimCall[]): SimBlock => ({
    calls: schedule
      ? [...selfChecks, balOf(DEAD, "0xdead", "Burn address balance before"), ...raiseCalls, ...voteCalls, ...extra]
      : [...selfChecks, balOf(DEAD, "0xdead", "Burn address balance before"), ...raiseCalls],
  });
  const challengeRead: SimCall = { label: "Read the active challenge", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "getActiveChallenge", kind: "read" };
  const adminLabel = c.admin ?? ZERO;

  const scenarioBlocks: Record<DryRunOutcome, SimBlock[]> = {
    raise: [
      raiseBlock([
        { label: "Holder C tries to oppose again (must fail)", actor: S3, actorLabel: "opposer", to: c.escrow, abi: ABI_W, functionName: "opposeChallenge", args: sigArgs("duplicate"), kind: "action", expectFailure: true },
        challengeRead,
        { label: "challengeSeq after filing", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "challengeSeq", kind: "read" },
        { label: "Vote recorded for B (1 = support)", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "challengeVoteBySeq", args: [seqNext, S2], kind: "read" },
        { label: "Vote recorded for C (2 = oppose)", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "challengeVoteBySeq", args: [seqNext, S3], kind: "read" },
        balOf(c.escrow, "escrow", `Escrow ${c.symbol} balance (holds the bond)`),
      ]),
    ],
    reject: [
      raiseBlock([]),
      {
        calls: [
          { label: "Admin rejects the challenge (impersonated in simulation)", actor: adminLabel as Address, actorLabel: "admin (simulated)", to: c.escrow, abi: [...ESCROW_ADMIN_ABI, ...E] as Abi, functionName: "rejectChallenge", kind: "action" },
          balOf(challengerAddr, "challenger", "Challenger balance after rejection"),
          balOf(DEAD, "0xdead", "Burn address balance after"),
          challengeRead,
          { label: "Tranche challenge flag cleared", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "trancheChallenged", args: [t], kind: "read" },
        ],
      },
    ],
    uphold: [
      raiseBlock([]),
      {
        calls: [
          { label: "Admin upholds the challenge (impersonated in simulation)", actor: adminLabel as Address, actorLabel: "admin (simulated)", to: c.escrow, abi: [...ESCROW_ADMIN_ABI, ...E] as Abi, functionName: "upholdChallenge", kind: "action" },
          balOf(challengerAddr, "challenger", "Challenger balance after uphold (bond returned)"),
          { label: "Campaign after uphold", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "getCampaign", kind: "read" },
          { label: "frozenEthBalance (ETH for holder refunds)", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "frozenEthBalance", kind: "read" },
          { label: "frozenTotalSupply (redeemable supply)", actor: S2, actorLabel: "reader", to: c.escrow, abi: E as Abi, functionName: "frozenTotalSupply", kind: "read" },
        ],
      },
    ],
    expire: [
      raiseBlock([]),
      {
        time: nowB + BigInt(Math.floor(c.adjudicationWindow / 2)),
        calls: [
          { label: `Anyone calls expireChallengeIfNeeded at +${Math.round(c.adjudicationWindow / 7200)}h (too early: no-op)`, actor: S3, actorLabel: "anyone", to: c.escrow, abi: E as Abi, functionName: "expireChallengeIfNeeded", kind: "action" },
          { ...challengeRead, label: "Challenge still Pending (state 1)" },
        ],
      },
      {
        time: nowB + BigInt(c.adjudicationWindow) + 3600n,
        calls: [
          { label: `Anyone calls expireChallengeIfNeeded after the ${Math.round(c.adjudicationWindow / 3600)}h adjudication window`, actor: S3, actorLabel: "anyone", to: c.escrow, abi: E as Abi, functionName: "expireChallengeIfNeeded", kind: "action" },
          balOf(challengerAddr, "challenger", "Challenger balance after expiry (full bond back)"),
          { ...challengeRead, label: "Challenge resolved as Rejected (state 3), no slash" },
        ],
      },
    ],
  };

  const TITLES: Record<DryRunOutcome, string> = {
    raise: "Raise, support, oppose",
    reject: "Admin rejects: 20% slash",
    uphold: "Admin upholds: raise frozen",
    expire: "No ruling: anyone expires it",
  };

  let selfCheck: DryRunResult["selfCheck"] = "ok";
  let selfCheckDetail = "trancheRequestedAt and challenger balance read back the overridden values inside the simulation.";
  const applicable = c.state === FUNDED && !!c.next;
  const reason = applicable ? null : c.state !== FUNDED ? `Escrow is ${CAMPAIGN_STATES[c.state] ?? c.state}: the deployed contract only accepts challenges in Funded (3). The raise attempt below shows its real revert.` : "No challengeable monthly tranche remains.";
  const runList: DryRunOutcome[] = applicable ? outcomes : ["raise"];

  const scenarios = await Promise.all(
    runList.map(async (outcome): Promise<DryRunScenario> => {
      try {
        const { steps, results } = await simulate(c, overrides, scenarioBlocks[outcome]);
        const b0 = results[0] ?? [];
        const expectedReq = !realPending && c.next && c.next.requestedAt === 0 ? requestedAt : BigInt(c.next?.requestedAt ?? 0);
        const reqBack = b0[0] as bigint | undefined;
        const balBack = b0[1] as bigint | undefined;
        if (!realPending && (reqBack !== expectedReq || balBack !== bond)) {
          selfCheck = "layout-mismatch";
          selfCheckDetail = `read-back trancheRequestedAt=${String(reqBack)} (expected ${expectedReq}), balance=${String(balBack)} (expected ${bond})`;
        }
        const facts: { label: string; value: string }[] = [];
        const deadBefore = (b0[2] as bigint | undefined) ?? null;
        const actionFails = steps.filter((s) => s.kind === "action" && s.status === "failure" && !s.expectFailure);
        if (outcome === "reject") {
          const b1 = results[1] ?? [];
          const after = b1[1] as bigint | undefined;
          const deadAfter = b1[2] as bigint | undefined;
          if (after !== undefined) facts.push({ label: "challengerAfter", value: after.toString() });
          if (deadAfter !== undefined && deadBefore !== null) facts.push({ label: "burned", value: (deadAfter - deadBefore).toString() });
        }
        if (outcome === "uphold") {
          const b1 = results[1] ?? [];
          const camp = b1[2] as { state?: number } | undefined;
          if (camp?.state !== undefined) facts.push({ label: "stateAfter", value: String(camp.state) });
          if (b1[3] !== undefined) facts.push({ label: "frozenEthBalance", value: String(b1[3]) });
          if (b1[4] !== undefined) facts.push({ label: "frozenTotalSupply", value: String(b1[4]) });
          if (b1[1] !== undefined) facts.push({ label: "challengerAfter", value: String(b1[1]) });
        }
        if (outcome === "expire") {
          const early = (results[1]?.[1] as { state?: number } | undefined)?.state;
          const late = results[2]?.[1] as bigint | undefined;
          const lateState = (results[2]?.[2] as { state?: number } | undefined)?.state;
          if (early !== undefined) facts.push({ label: "stateEarly", value: String(early) });
          if (late !== undefined) facts.push({ label: "challengerAfter", value: late.toString() });
          if (lateState !== undefined) facts.push({ label: "stateAfter", value: String(lateState) });
        }
        if (outcome === "raise") {
          const ch = b0.find((x) => x && typeof x === "object" && "challenger" in (x as object)) as { state?: number; amount?: bigint } | undefined;
          if (ch?.amount !== undefined) facts.push({ label: "stakeHeld", value: ch.amount.toString() });
        }
        const ok = actionFails.length === 0 && applicable;
        let summary: string;
        if (!applicable) summary = actionFails[0]?.revert ? `The real contract refuses: ${actionFails[0].revert}. ${actionFails[0].revertText ?? ""}`.trim() : "Not applicable in the current state.";
        else if (!ok) summary = `Step failed: ${actionFails[0]?.label} -> ${actionFails[0]?.revert ?? "reverted"}`;
        else if (outcome === "raise") summary = `Challenge filed with a ${c.symbol} bond, B's support and C's opposition recorded; a duplicate vote reverts. Tranche payout is now blocked.`;
        else if (outcome === "reject") summary = `Admin rejection burns 20% of the bond to 0xdead and returns 80% to the challenger; the tranche can be challenged again by someone else.`;
        else if (outcome === "uphold") summary = `Upholding freezes the raise (state 5), returns the full bond and snapshots ETH + redeemable supply for pro-rata holder refunds.`;
        else summary = `Before the ${Math.round(c.adjudicationWindow / 3600)}h adjudication window lapses expiry is a no-op; after it, anyone can expire the challenge and the full bond is returned with no slash.`;
        return { outcome, title: TITLES[outcome], summary, ok, steps, facts };
      } catch (e) {
        return { outcome, title: TITLES[outcome], summary: "Simulation RPC call failed.", ok: false, steps: [], facts: [], error: errMsg(e) };
      }
    })
  );

  return { ...base, applicable, reason, overrides: overrideList, selfCheck, selfCheckDetail, scenarios, elapsedMs: Date.now() - t0 };
}

/** Run the Challenge Dry-Run for one escrow. */
export async function runChallengeDryRun(chainId: ChainId, escrow: Address, outcomes: DryRunOutcome[] = DRY_RUN_OUTCOMES): Promise<DryRunResult> {
  const c = await loadCtx(chainId, escrow);
  return runScenarios(c, outcomes);
}
