/**
 * JSON-safe report types. Every uint256 is carried as a decimal string ("raw")
 * so it survives JSON and is re-hydrated with BigInt() on the client.
 */

export type ChainId = 8453 | 4663;
export type Severity = "info" | "warn" | "critical";
export type ThreatBand = "NOMINAL" | "ELEVATED" | "CRITICAL";
export type TargetKind = "wallet" | "token" | "pool" | "escrow" | "contract";

export interface BlockRef {
  chainId: ChainId;
  number: string;
  timestamp: number;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  points: number;
  link?: { label: string; href: string };
}

export interface TokenMeta {
  address: string;
  chainId: ChainId;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
}

export type ControllerKind = "renounced" | "eoa" | "safe" | "contract" | "eip7702" | "unknown";

export interface ControllerPosture {
  role: string;
  address: string | null;
  kind: ControllerKind;
  safeThreshold?: number;
  safeOwners?: number;
  /** Human label, e.g. a known EIP-7702 wallet delegator ("MetaMask EIP7702StatelessDeleGator"). */
  label?: string;
  /** For non-Safe contract controllers (ProxyAdmin, beacon…): the posture of that contract's own owner(). */
  resolvedOwner?: ControllerPosture;
}

export interface SelectorHit {
  selector: string;
  signature: string;
  severity: "info" | "warn" | "high";
  label: string;
  explanation: string;
  /** Capability group (mint, blacklist, upgrade…) so one capability scores once. */
  capability?: string;
}

/**
 * How the X-Ray found the logic that actually runs:
 *  eip1967-transparent: impl + admin slots (admin slot holds the upgrade key, often a ProxyAdmin)
 *  eip1967-uups: impl slot set, admin slot empty — upgrade authority lives in the implementation (owner()/roles)
 *  eip1967-beacon: beacon slot → IBeacon.implementation()
 *  zeppelinos-legacy: org.zeppelinos.proxy.implementation/admin slots (e.g. Base USDC FiatTokenProxy)
 *  eip897: implementation() view on a delegatecall forwarder with empty slots
 *  eip1167-clone: immutable minimal proxy · none: not a proxy
 */
export type ProxyKind = "none" | "eip1967-transparent" | "eip1967-uups" | "eip1967-beacon" | "zeppelinos-legacy" | "eip897" | "eip1167-clone";

export interface XrayReport {
  chainId: ChainId;
  address: string;
  isContract: boolean;
  byteSize: number;
  eip7702Delegate: string | null;
  /** Known wallet delegator label for `eip7702Delegate` (null = unknown delegate). */
  eip7702DelegateLabel: string | null;
  eip1167CloneTarget: string | null;
  /** Resolved logic address (EIP-1967 slot, beacon implementation(), zeppelinos slot or EIP-897). */
  implementation: string | null;
  /** Admin slot value (EIP-1967 or zeppelinos). */
  admin: string | null;
  beacon: string | null;
  proxyKind: ProxyKind;
  /** Who can swap the implementation (null when not upgradeable or authority unreadable — see proxyKind). */
  upgradeAuthority: ControllerPosture | null;
  analyzedCodeAddress: string | null;
  matchedSelectors: SelectorHit[];
  hasSelfdestruct: boolean;
  hasDelegatecall: boolean;
  /** Dispatcher selectors (PUSH4 used in a selector comparison) in the analyzed code. */
  push4Count: number;
  controllers: ControllerPosture[];
  /**
   * Small DELEGATECALL forwarder whose logic address could not be resolved (no EIP-1967/ZeppelinOS slot, no
   * EIP-897 answer, no recognised clone pattern — e.g. a Diamond or slot-0 singleton proxy). The selectors of
   * the code that really runs were NOT scanned: UNKNOWN, never clean.
   */
  unresolvedDelegatecall?: boolean;
  /** true when an RPC read failed: results are incomplete and must be treated as UNKNOWN, never as clean. */
  degraded: boolean;
  degradedReasons: string[];
}

export interface OvernightPoolDelta {
  method: "historical-state" | "event-logs" | "unavailable";
  hours: number;
  fromBlock: string | null;
  /**
   * @deprecated alias of `lpChangeBps` (kept so existing consumers read the LP metric, not a swap-driven reserve delta).
   */
  reserve0ChangeBps: number | null;
  /**
   * Liquidity provided by LPs, overnight change in bps: v2 = pool LP totalSupply (fallback √k);
   * CL = in-range liquidity added/removed via Mint/Burn (fallback active liquidity L). Swaps do not move it.
   */
  lpChangeBps: number | null;
  /** How lpChangeBps was measured. */
  lpMethod: string | null;
  /**
   * CL pools only: change of active liquidity L at the current tick (archive state). Moves when price crosses
   * initialized ticks, so it is context — never scored as an LP withdrawal.
   */
  activeLiquidityChangeBps?: number | null;
  /** Set when the overnight read FAILED (RPC): LP/price changes are UNKNOWN, the scan is incomplete. */
  degraded?: string;
  /** Change of the quote-side (WETH/USDC…) reserve — moves with swaps as well as LP flows. */
  quoteReserveChangeBps: number | null;
  /** Price of the risky token in the quote token (e.g. VIBES in WETH), overnight change in bps. */
  priceChangeBps: number | null;
  /** e.g. "VIBES priced in WETH". */
  priceOrientation: string | null;
  swapCount: number | null;
  token0Volume: string | null;
  /** Gross quote-side swap volume (raw units of the quote token). */
  quoteVolume: string | null;
  note: string;
}

export interface PoolSnapshot {
  chainId: ChainId;
  address: string;
  kind: "aerodrome-v2" | "aerodrome-cl" | "uniswap-v3";
  /** e.g. "Aerodrome volatile", "Aerodrome Slipstream CL (tick spacing 100)", "Uniswap v3". */
  venue: string;
  token0: TokenMeta;
  token1: TokenMeta;
  /** Fee in whole bps, rounded UP from feePips (always an integer, safe for BigInt()). */
  feeBps: number;
  /** Exact fee in pips (1e-6), e.g. Slipstream 150 = 0.015%. */
  feePips: number;
  tickSpacing: number | null;
  /** Side that is canonical WETH, by address. */
  wethSide: 0 | 1 | null;
  /** Quote side (USDC/WETH/… by address) that exits settle into; null = no known quote asset. */
  quoteSide: 0 | 1 | null;
  stable: boolean;
  factory: string | null;
  reserve0: string;
  reserve1: string;
  reservesAreVirtual: boolean;
  sqrtPriceX96: string | null;
  liquidity: string | null;
  tick: number | null;
  token1PerToken0: string; // scaled 1e18
  token0PerToken1: string; // scaled 1e18
  block: BlockRef;
  overnight: OvernightPoolDelta;
}

export interface OvernightTokenFlow {
  available: boolean;
  hours: number;
  fromBlock: string | null;
  transferCount: number;
  volume: string;
  largestTransfer: string;
  largestTransferTx: string | null;
  topHolder: { address: string; balance: string; shareBps: number; isContract: boolean; activeOvernight?: boolean } | null;
  note: string;
  /** Largest current holders found (excluding pools, bridges, escrows, zero/burn), ranked by live balanceOf. */
  holders?: TokenHolder[];
  /** Combined share of `holders` (top ≤10) in bps of total supply. */
  topHoldersShareBps?: number;
  /** How holder candidates were discovered (Transfer-log history) and how much of it was actually read. */
  holderScan?: HolderScanCoverage;
  /** Coverage of the 8h Transfer-log read itself. */
  overnightCoverage?: LogCoverage;
  /** Live reads that FAILED (RPC): whale/flow results are UNKNOWN, the scan is incomplete. */
  degraded?: string[];
}

export interface TokenHolder {
  address: string;
  balance: string;
  shareBps: number;
  isContract: boolean;
  activeOvernight: boolean;
}

/** Block coverage of a chunked eth_getLogs read (see src/lib/engine/logs.ts). */
export interface LogCoverage {
  fromBlock: string;
  toBlock: string;
  /** Lowest block of the contiguous range ending at toBlock that was read (null = newest chunk failed). */
  coveredFromBlock: string | null;
  complete: boolean;
  chunks: number;
  failedRanges: number;
  truncated: boolean;
  provider: string;
  note: string;
}

export interface HolderScanCoverage {
  method: "transfer-history";
  /** Target lookback (days; null = the whole chain since genesis) and the oldest block of it. */
  windowDays: number | null;
  windowFromBlock: string;
  toBlock: string;
  /** Blocks of the window actually read so far (accumulates across scans via the KV holder index). */
  blocksCovered: string;
  blocksInWindow: string;
  complete: boolean;
  candidates: number;
  balancesChecked: number;
  note: string;
}

export interface ApprovalExposure {
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  spender: string;
  spenderName: string;
  kind: "erc20" | "permit2";
  amount: string;
  unlimited: boolean;
  expiration?: number;
  discoveredOvernight: boolean;
  /** false when the spender is not in Kestrel's verified spender list (found via Approval logs). */
  spenderKnown?: boolean;
  /** How this approval was found: curated token×spender matrix, or the wallet's own Approval/Permit2 logs. */
  source?: "matrix" | "approval-log";
  /** true when symbol()/decimals() could not be read (RPC): tokenSymbol/tokenDecimals are placeholders — do not scale `amount`. */
  tokenMetaUnread?: boolean;
}

export type WalletAccountKind = "eoa" | "eip7702" | "safe" | "coinbase-smart-wallet" | "erc4337" | "smart-wallet";

/** What kind of account the scanned wallet is (smart-contract wallets are wallets, not "contracts"). */
export interface WalletAccountInfo {
  kind: WalletAccountKind;
  label: string;
  safe?: { threshold: number; owners: string[]; version: string | null };
  entryPoint?: string | null;
  implementation?: string | null;
  delegate?: string | null;
}

/** Exactly what the approval scan covered, so UI/brief copy can state it honestly. */
export interface ApprovalCoverage {
  tokensChecked: number;
  curatedTokens: number;
  /** Tokens added from the wallet's Approval / Transfer logs or the `tokens` param. */
  discoveredTokens: number;
  spendersChecked: number;
  curatedSpenders: number;
  /** Spenders added from Approval / Permit2 logs (not in the verified list). */
  discoveredSpenders: number;
  permit2SpendersChecked: number;
  /** allowance() calls made: tokens × spenders (ERC-20) and Permit2 (token, spender) pairs. */
  erc20PairsChecked: number;
  permit2PairsChecked: number;
  failedCalls: number;
  /** Lookback of the Approval/Permit2 log discovery and how much of it was read. */
  logLookbackHours: number;
  logCoverage: LogCoverage | null;
  /** True when logs were searched across ALL tokens (not just the curated list) — Robinhood Chain, or Base with BASE_LOGS_RPC_URL. */
  walletWideLogDiscovery: boolean;
  /** Robinhood: per-address Approval/Permit2 reads over the last 10M blocks (~12 days) that completed. */
  deepHistoryReads: number;
  partial: boolean;
  notes: string[];
}

export interface WalletHolding {
  token: string;
  symbol: string;
  decimals: number;
  balance: string;
}

export interface WalletReport {
  chainId: ChainId;
  address: string;
  nativeBalance: string;
  eip7702Delegate: string | null;
  holdings: WalletHolding[];
  approvals: ApprovalExposure[];
  spendersChecked: number;
  overnightApprovalScan: { available: boolean; hours: number; newApprovals: number; note: string };
  /** Account classification (EOA, EIP-7702, Safe, Coinbase Smart Wallet, ERC-4337). */
  account?: WalletAccountInfo;
  /** What the approval scan covered (tokens × spenders, log window, partial flags). */
  coverage?: ApprovalCoverage;
}

export type TrancheStatus =
  | "PAID"
  | "CHALLENGE_WINDOW"
  | "CLAIMABLE"
  | "CHALLENGED"
  | "ELIGIBLE"
  | "LOCKED"
  | "HALTED";

export interface TrancheView {
  index: number;
  label: string;
  /** Share of the ESCROWED funds (10% kickstart / 15% monthly); escrow holds 85% of the raise, 15% went to LP. */
  bps: number;
  /** Share of the total raise = amount / totalRaised (BigInt math), e.g. 850 = 8.50%. Null if nothing raised. */
  bpsOfRaised?: number | null;
  amount: string;
  unlockTime: number;
  requestedAt: number;
  windowEndsAt: number;
  claimed: boolean;
  challenged: boolean;
  status: TrancheStatus;
  paidTxHash: string | null;
}

export interface EscrowReport {
  chainId: ChainId;
  address: string;
  title: string | null;
  tagline: string | null;
  apiStatus: string | null;
  state: number;
  stateLabel: string;
  raiseTypeLabel: string;
  founder: string;
  token: string;
  tokenSymbol: string | null;
  totalRaised: string;
  escrowBalance: string;
  nextTranche: number;
  startTime: number;
  oracleTime: number;
  challengeWindowSeconds: number;
  lpCreated: boolean;
  lpWithdrawn: boolean;
  lpLockTxHash: string | null;
  allTranchesClaimed: boolean;
  activeChallenge: { challenger: string; reason: string; tranche: number; timestamp: number; state: number; stateLabel: string } | null;
  challengeThresholdBps: number | null;
  tranches: TrancheView[];
  capsule: { registered: boolean; capsuleHash: string | null; provenanceLabel: string | null; agentName: string | null } | null;
  founderSignals: {
    githubUsername: string | null;
    githubCommits: number | null;
    ethosScore: number | null;
    ethosLevel: string | null;
    xHandle: string | null;
    xFollowers: number | null;
    humanVerified: boolean | null;
  } | null;
  contributorCount: number | null;
  holderCount: number | null;
  appHealth: { url: string; status: number | null; latencyMs: number | null; ok: boolean; checkedAt?: string; error?: string | null } | null;
  block: BlockRef;
  // ---- Backer Shield v2 enrichment (all optional for backward compatibility) ----
  /** Launch tx hash (= Vibestarter MCP slug) or "vibes" for Genesis. */
  launchTx?: string | null;
  /** https://app.vibestarter.xyz/raises/{launchTx|vibes} */
  vibestarterUrl?: string | null;
  /** v1 = Genesis impl (backend-signature gated challenges, 72 h auto-expiry); v2 = eligibility-registry gated (7 d). */
  generation?: "v1" | "v2" | "unknown";
  appUrl?: string | null;
  repoUrl?: string | null;
  /** On-chain Proof-of-Lock (VibesLPLockerV2.verifyLPLocked + soulbound share of pool LP supply). */
  lpLock?: LpLockProof | null;
  founderGithub?: GithubVelocity | null;
  /** Most recent resolved challenge (Upheld / Rejected) — `activeChallenge` is only set while Pending. */
  lastChallenge?: { challenger: string; reason: string; tranche: number; timestamp: number; state: number; stateLabel: string } | null;
  /** The next scheduled event to count down to (always set when one exists, even if no window is open). */
  nextEvent?: EscrowNextEvent | null;
  /** The most recently requested tranche's challenge window (open or closed). */
  lastWindow?: { tranche: number; label: string; requestedAt: number; windowEndsAt: number; open: boolean; challenged: boolean; claimed: boolean; amount: string } | null;
  refund?: RefundRadar | null;
  raiseDeadline?: number | null;
  /** Unclaimed router-held backer tokens for this raise (VibesLaunchRouterV2.backerTokensForClaims). */
  backerTokensUnclaimed?: string | null;
  tokenDecimals?: number | null;
}

export type EscrowNextEventKind =
  | "raise-deadline"
  | "window-closes"
  | "challenge-adjudication"
  | "tranche-unlock"
  | "awaiting-request"
  | "awaiting-claim"
  | "refund-sweep";

export interface EscrowNextEvent {
  kind: EscrowNextEventKind;
  /** unix seconds; null when the event has no fixed time (e.g. founder must still request). */
  at: number | null;
  label: string;
  detail: string;
  tranche: number | null;
  amount: string | null;
}

export interface RefundRadar {
  /** contributor = Failed raise, claimContributorRefund() (no proof); holder = Refunding, claimHolderRefund(amount, proof). */
  mode: "contributor" | "holder";
  claimFunction: string;
  escrowBalance: string;
  /** Unix seconds after which the admin may sweep unclaimed holder refunds (Refunding only; Failed has no deadline). */
  sweepAfter: number | null;
  refundingStartTime: number | null;
  frozenEthBalance: string | null;
  frozenTotalSupply: string | null;
  tokensRedeemed: string | null;
  redeemedBps: number | null;
  /** ETH still owed to holders who have not claimed (frozenEth × unredeemed / frozenSupply). */
  unclaimedEthEstimate: string | null;
  /** ETH per 1,000,000 whole tokens (scaled 1e18). */
  ethPerMillionTokens: string | null;
  allClaimed: boolean;
  proofSource: string | null;
  note: string;
}

export type LpLockStatus = "verified" | "rescued" | "not-locked" | "unavailable";

export interface LpLockProof {
  status: LpLockStatus;
  chainId: number;
  locker: string | null;
  lockerVersion: "v1" | "v2" | null;
  pool: string | null;
  feeClaimer: string | null;
  /** Fee claimer bytecode == canonical 45-byte EIP-1167 clone of the audited VibesLPFeeClaimer impl. */
  claimerIsImmutableClone: boolean | null;
  lpLocked: string | null;
  lpTotalSupply: string | null;
  lockedShareBps: number | null;
  /** Max share of pool LP that could ever be withdrawn by anyone (10000 − lockedShareBps). */
  unlockedShareBps: number | null;
  ethPaired: string | null;
  tokensPaired: string | null;
  lockedAt: number | null;
  routerLpStatus: number | null;
  routerLpStatusLabel: string | null;
  lockTx: { hash: string; verified: boolean; block: string | null; note: string } | null;
  note: string;
  block: string | null;
}

export interface GithubVelocity {
  login: string;
  status: "ok" | "not-found" | "rate-limited" | "error";
  profileUrl: string;
  pushes7d: number | null;
  pushes30d: number | null;
  activeDays30d: number | null;
  commits7d: number | null;
  commits30d: number | null;
  commitsCapped: boolean;
  reposPushed30d: string[];
  lastPushAt: string | null;
  lastEventAt: string | null;
  capsuleRepo: { fullName: string; status: "ok" | "not-found" | "error"; pushedAt: string | null; stars: number | null; archived: boolean | null } | null;
  note: string;
  fetchedAt: string;
  authenticated: boolean;
}

/* ---------------------------- LayerZero OFT bridge ---------------------------- */

export type OftDirection = "base->robinhood" | "robinhood->base";

export interface OftCreditBudget {
  /** enforced on the DESTINATION adapter: creditBudget(srcEid) / rateLimits(srcEid) — raw VIBES (18 dec) */
  limit: string;
  windowSec: number;
  inFlight: string; // decayed, as the contract computes it at the read block
  headroom: string; // canCredit
  refillPerSec: string; // limit / window (raw units per second)
  lastCreditAt: number | null; // rateLimits().lastUpdated (unix s) — last credit (or config checkpoint)
  secondsToFull: number | null; // until inFlight decays to 0
}

export interface OftLane {
  direction: OftDirection;
  srcChainId: ChainId;
  dstChainId: ChainId;
  srcEid: number;
  dstEid: number;
  srcAdapter: string;
  dstAdapter: string;
  /** true = both peers point at each other; false = a READ peer is wrong; null = a peer read failed (UNKNOWN). */
  peersOk: boolean | null;
  /** quoteSend(…, false).nativeFee — ONE message, paid in src-chain ETH, amount-independent ("0" if the quote failed) */
  nativeFeeWei: string;
  feeBreakdown: { executorWei: string; dvns: { address: string; name: string | null; feeWei: string }[]; treasuryWei: string } | null;
  enforcedLzReceiveGas: string | null;
  credit: OftCreditBudget | null;
  srcPaused: boolean | null;
  dstPaused: boolean | null;
  confirmations: number | null;
  requiredDvns: { address: string; name: string | null }[];
  optionalDvns: { address: string; name: string | null }[];
  optionalDvnThreshold: number | null;
  /** src send-ULN vs dst receive-ULN agree on confirmations + DVN counts (mismatch = messages cannot verify) */
  configMatches: boolean | null;
  nonces: {
    outbound: string; // src endpoint
    inboundVerified: string; // dst endpoint inboundNonce (contiguous verified)
    lazyExecuted: string; // dst endpoint lazyInboundNonce
    unverified: number; // outbound − inboundVerified: sent, waiting for DVNs (0 when `known` is false — NOT a measurement)
    /** false when outbound/inbound nonces could not be read: `unverified` is UNKNOWN, nonce strings are "unknown". */
    known?: boolean;
    awaitingExecution: { nonce: string; payloadHash: string }[]; // verified at dst but not executed (rate-limited / paused / gas)
  };
}

export interface OftGovernance {
  owner: string | null;
  /** Safe multisig posture of owner() (null when the owner is not a Safe or unreadable) */
  ownerSafe: { threshold: number; owners: number } | null;
  ownerIsContract: boolean | null;
  pauser: string | null;
  pauserIsContract: boolean | null;
  /** LayerZero endpoint delegate (can change DVN / library config) */
  delegate: string | null;
}

export interface OftBridgeReport {
  lanes: OftLane[]; // [base->robinhood, robinhood->base]
  dustUnit: string; // decimalConversionRate (1e12)
  owner: Record<ChainId, string | null>;
  pauser: Record<ChainId, string | null>;
  delegate: Record<ChainId, string | null>;
  governance: Record<ChainId, OftGovernance>;
  blocks: { base: BlockRef; robinhood: BlockRef };
  fetchedAt: string;
}

export interface ArbRoundTripView {
  direction: OftDirection; // the bridge lane the arb uses (cheap venue → rich venue)
  lzFeeWei: string;
  gasWei: string;
  reference: { wethIn: string; wethOut: string; vibesBridged: string; profitWei: string; netEdgeBps: number | null; lzFeeBps: number | null; gasBps: number | null };
  optimal: { wethIn: string; wethOut: string; vibesBridged: string; profitWei: string; netEdgeBps: number | null } | null;
  /** seconds the bridged size must wait for credit headroom (0 = immediate, null = lane fail-closed) */
  creditWaitSec: number | null;
  model: string;
}

export type ParityVerdict = "EXACT" | "IN_FLIGHT" | "OVER_BACKED" | "UNBACKED";

/** Live onchain ETH/USD reference (Uniswap v3 WETH/USDC slot0 on Base). */
export interface EthUsdQuote {
  /** raw USDC (6 decimals) per 1 WETH */
  usdcPerWeth: string;
  pool: string;
  chainId: ChainId;
  block: string;
  source: string;
}

export interface ParityReport {
  base: BlockRef;
  robinhood: BlockRef;
  lockedOnBase: string;
  rhTotalSupply: string;
  rhReserve: string;
  rhCirculating: string;
  delta: string;
  verified: boolean;
  basePool: PoolSnapshot | null;
  rhPool: PoolSnapshot | null;
  baseVibesPerWeth: string;
  rhVibesPerWeth: string;
  /** + => Robinhood quotes more VIBES per WETH (VIBES cheaper on Robinhood). */
  spreadBps: number | null;
  cheaperVenue: "base" | "robinhood" | null;
  feeDragBps: number | null;
  /** Headline: |spread| − pool fees − live LayerZero fee − gas, in bps of `arbNotionalWei`; null when the LayerZero fee could not be read live. */
  netEdgeBps: number | null;
  gas: { baseGwei: string; rhGwei: string; swapGasUnits: number; baseSwapCostWei: string; rhSwapCostWei: string };
  /** locked − circulating (signed raw). >0 = over-backed or packets in flight; <0 = UNBACKED supply on Robinhood */
  deltaSigned: string;
  verdict: ParityVerdict;
  /** LayerZero packets sent but not yet delivered across both lanes (unverified + verified-not-executed); null = nonce reads failed (UNKNOWN). */
  pendingPackets: number | null;
  /** Set when the OFT bridge/nonce/peer reads failed: in-flight count and peer wiring are UNKNOWN (scan incomplete). */
  bridgeDegraded?: string;
  /** |spread| − pool fees (the old netEdgeBps semantics) */
  netEdgeBpsBeforeBridge: number | null;
  bridgeFeeBps: number | null;
  gasBps: number | null;
  /** notional the bps figures are expressed against (raw WETH wei, default 0.1 WETH) */
  arbNotionalWei: string;
  bridge: OftBridgeReport | null;
  arb: ArbRoundTripView | null;
  ethUsd: EthUsdQuote | null;
  fetchedAt: string;
}

export interface BriefResult {
  text: string;
  source: "deterministic" | "0g-compute" | "anthropic";
  model: string | null;
}

export interface ScanResult {
  target: { address: string; chainId: ChainId; kind: TargetKind; label: string };
  block: BlockRef;
  score: number;
  band: ThreatBand;
  findings: Finding[];
  token: TokenMeta | null;
  xray: XrayReport | null;
  pool: PoolSnapshot | null;
  flow: OvernightTokenFlow | null;
  wallet: WalletReport | null;
  escrow: EscrowReport | null;
  parity: ParityReport | null;
  brief: BriefResult;
  generatedAt: string;
  durationMs: number;
}
