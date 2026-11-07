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
}

export interface SelectorHit {
  selector: string;
  signature: string;
  severity: "info" | "warn" | "high";
  label: string;
  explanation: string;
}

export interface XrayReport {
  chainId: ChainId;
  address: string;
  isContract: boolean;
  byteSize: number;
  eip7702Delegate: string | null;
  eip1167CloneTarget: string | null;
  implementation: string | null;
  admin: string | null;
  beacon: string | null;
  analyzedCodeAddress: string | null;
  matchedSelectors: SelectorHit[];
  hasSelfdestruct: boolean;
  hasDelegatecall: boolean;
  push4Count: number;
  controllers: ControllerPosture[];
}

export interface OvernightPoolDelta {
  method: "historical-state" | "event-logs" | "unavailable";
  hours: number;
  fromBlock: string | null;
  reserve0ChangeBps: number | null;
  priceChangeBps: number | null;
  swapCount: number | null;
  token0Volume: string | null;
  note: string;
}

export interface PoolSnapshot {
  chainId: ChainId;
  address: string;
  kind: "aerodrome-v2" | "uniswap-v3";
  token0: TokenMeta;
  token1: TokenMeta;
  feeBps: number;
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
  topHolder: { address: string; balance: string; shareBps: number; isContract: boolean } | null;
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
  bps: number;
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
  appHealth: { url: string; status: number | null; latencyMs: number | null; ok: boolean } | null;
  block: BlockRef;
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
  netEdgeBps: number | null;
  gas: { baseGwei: string; rhGwei: string; swapGasUnits: number; baseSwapCostWei: string; rhSwapCostWei: string };
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
