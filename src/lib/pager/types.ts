/**
 * Night-Shift Pager data model (spec section 5). Every pager module codes against these types.
 * All uint256 values are carried as decimal strings (never JS Number) so they survive JSON + Redis.
 *
 * CLIENT-SAFE: this module is types only (no runtime imports), so UI code may import from it. Keep it that way:
 * the other client-safe pager modules are `rules.ts` (catalogue + validation) and `constants.ts`; everything else
 * in src/lib/pager is marked `import "server-only"` (node:crypto / node:dns / node:http(s) / KV).
 */
import type { ChainId, Severity, TargetKind, ThreatBand } from "@/lib/engine/types";

export type Hex = `0x${string}`;

export type RuleType =
  | "lp_liquidity_drop" | "price_move" | "spread_bps" | "parity_drift"
  | "escrow_window_opened" | "escrow_window_closing" | "escrow_unlock_soon" | "escrow_challenge_or_state"
  | "wallet_new_approval" | "wallet_activity"
  | "proxy_upgrade" | "admin_change" | "bridge_peer_change"
  | "whale_transfer" | "supply_change" | "band_change";

interface RuleBase<T extends RuleType> { id: string; type: T; enabled: boolean; cooldownMin?: number }
export type RuleConfig =
  | (RuleBase<"lp_liquidity_drop"> & { dropBps: number; windowMin: number })        // default 1500 / 60
  | (RuleBase<"price_move"> & { moveBps: number; windowMin: number })               // default 2000 / 60
  | (RuleBase<"spread_bps"> & { maxBps: number })                                   // default 300
  | (RuleBase<"parity_drift"> & { persistMin: number })                             // default 10
  | RuleBase<"escrow_window_opened">
  | (RuleBase<"escrow_window_closing"> & { marksHours: number[] })                  // default [24, 6, 1]
  | (RuleBase<"escrow_unlock_soon"> & { leadHours: number })                        // default 72 (demo: 168)
  | RuleBase<"escrow_challenge_or_state">
  | (RuleBase<"wallet_new_approval"> & { knownSpenders: "warn" | "ignore" })        // default "warn"
  | RuleBase<"wallet_activity">
  | RuleBase<"proxy_upgrade">
  | RuleBase<"admin_change">
  | RuleBase<"bridge_peer_change">
  | (RuleBase<"whale_transfer"> & { minBpsOfSupply: number })                       // default 100 (1%)
  | (RuleBase<"supply_change"> & { minBps: number })                                // default 10 (0.1%)
  | (RuleBase<"band_change"> & { everyMin: number });                               // default 60

export interface TokenRef { address: Hex; symbol: string; decimals: number }

export interface Watch {
  v: 1;
  id: string;                      // "w_" + 10 base64url chars
  deskId: string;
  chainId: ChainId;
  target: Hex;                     // checksummed
  kind: TargetKind;                // from scanTarget at arm time
  label: string;                   // plain text, ≤ 80 chars, control chars stripped, never rendered as HTML
  enabled: boolean;
  rules: RuleConfig[];
  /** Static facts captured once at arm time, so the tick never re-classifies. */
  meta: {
    pool?: { address: Hex; kind: "aerodrome-v2" | "aerodrome-cl" | "uniswap-v3"; token0: TokenRef; token1: TokenRef; feeBps: number; wethSide: 0 | 1 | null;
             /** Quote side by ADDRESS (USDC > USDbC > WETH > cbBTC, engine/sides.ts); derived on the fly for older watches. */
             quoteSide?: 0 | 1 | null };
    token?: TokenRef;
    proxy?: { slots: ("eip1967Impl" | "eip1967Admin" | "eip1967Beacon" | "ozImpl" | "ozAdmin")[]; hasOwnerFn: boolean; safe: Hex | null };
    approvalTokens?: Hex[];        // Base address filter (TRACKED_TOKENS ∪ user extras ∪ held at arm); RH uses topic-only
    bridge?: { chainId: ChainId; adapter: Hex; eid: number; expectedPeer: Hex }[];
    vibes?: boolean;               // target ∈ $VIBES set → parity/spread/peer rules available
    isEoa?: boolean;               // wallet_activity only meaningful for EOAs / 7702 EOAs
  };
  createdAt: number;
  updatedAt: number;
}

export interface PoolSample {
  at: number; block: string; liq: string;
  px: string;        /* risky token priced in the quote token (1e18); see `q` */
  wethDepth: string; /* quote-side depth in raw quote units (historically WETH) */
  /** Quote side the sample is oriented on (absent = legacy wethSide orientation). Samples of another orientation are never compared. */
  q?: 0 | 1;
}

export interface WatchState {
  v: 1;
  watchId: string;
  armedAt: number;
  armedBlock: string;
  lastCheckedAt: number | null;
  lastCheckedBlock: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  pool?: { armed: PoolSample; samples: PoolSample[] };            // ring, ≤ 40, ≥ 1 per 2 min
  supply?: { armed: string; last: string };
  code?: { impl: string | null; admin: string | null; beacon: string | null; ozImpl: string | null; ozAdmin: string | null;
           owner: string | null; selectors: string[]; safe: { threshold: number; owners: string[] } | null; paused?: boolean };
  peers?: Record<string /* eid */, string /* bytes32 */>;
  wallet?: { balance: string; nonce: number | null; openApprovals: Record<string /* token:spender */, { alertId: string; at: number }> };
  escrow?: { state: number; nextTranche: number; requestedAt: number[]; claimed: boolean[]; challenged: boolean[];
             challengeTs: number; challengeState: number; marksFired: Record<string /* tranche */, number[]> };
  scan?: { score: number; band: ThreatBand; at: number; block: string; pendingBand?: ThreatBand };
  seen: string[];                                  // last 100 dedupe keys
  cooldownUntil: Record<string /* ruleId */, number>;
  firing: Record<string /* ruleId */, boolean>;    // hysteresis: condition currently true
  unbackedAlertId?: string;                        // id of the fired "UNBACKED $VIBES" alert, resolved by the recovery page
  lastAlert: { ruleType: RuleType; title: string; severity: Severity; at: number } | null;
  alertCount: number;
}

export interface Desk {
  v: 1;
  id: string;                      // base64url(sha256(deskKey)).slice(0, 22)
  createdAt: number;
  label: string | null;
  watchIds: string[];
  channels: {
    telegram: { chatId: string; username: string | null; chatType: "private" | "group" | "supergroup" | "channel";
                linkedAt: number; verified: boolean; disabledReason: string | null } | null;
    webhook: { url: string; kind: "discord" | "slack" | "generic"; secret: string /* HMAC for generic */;
               addedAt: number; failures: number; disabledReason: string | null } | null;
  };
  policy: { sleepMode: "critical-only" | "page-all" };
  system?: boolean;                // the public $VIBES system desk
  ipHash?: string;                 // sha256(ip + daily salt) for per-IP desk caps
}

export interface PagerAlert {
  id: string;                      // sha256(watchId:dedupeKey).slice(0, 16)
  deskId: string;
  watchId: string;
  ruleId: string;
  ruleType: RuleType;
  severity: Severity;              // "info" (resolved / digest-only) | "warn" | "critical"
  title: string;                   // plain text
  lines: string[];                 // plain-text facts (numbers via fmtUnits / fmtBps; never JS Number on raw uint256)
  chainId: ChainId;
  target: Hex;
  block: string;                   // evidence block
  txHash: Hex | null;
  evidence: { label: string; href: string }[];   // explorer links built from validated addresses/hashes
  actions: { label: string; href: string }[];    // e.g. "Revoke in Panic Bunker" → /rescue?…
  at: number;
  deferred?: boolean;
  resolves?: string;               // id of the alert this one resolves
}

export interface OutboxItem {
  id: string;                      // `${deskId}:${tickId}` or `${deskId}:digest:${wakeAt}`
  deskId: string;
  kind: "alerts" | "digest" | "test";
  alerts: PagerAlert[];
  digest?: DigestPayload;
  status: { telegram?: "pending" | "sent" | "failed"; webhook?: "pending" | "sent" | "failed" };
  attempts: number;
  createdAt: number;
  /** Sleep Mode woke the desk for this page: retries keep the "Woke you because:" intro. */
  wokeYou?: boolean;
}

export interface WatchDigestSnapshot {
  label: string; kind: TargetKind; chainId: ChainId; target: Hex;
  liq?: string; px?: string; wethDepth?: string; supply?: string; impl?: string | null; owner?: string | null;
  balance?: string; nonce?: number | null; escrow?: { statuses: string[]; nextTranche: number; state: number };
  band?: ThreatBand; score?: number; block: string | null;
}

export interface SleepSession {
  deskId: string;
  startedAt: number;
  wakeAt: number;                  // ms UTC
  tz: string | null;               // IANA zone, display only
  policy: "critical-only" | "page-all";
  startBlocks: Partial<Record<ChainId, string>>;
  startTickCount: number;
  snapshot: Record<string /* watchId */, WatchDigestSnapshot>;
  deferred: PagerAlert[];          // ≤ 50
  paged: { alertId: string; title: string; severity: Severity; at: number }[];
}

export interface DigestPayload {
  deskId: string; startedAt: number; endedAt: number; tz: string | null;
  checks: number; blocks: Partial<Record<ChainId, { from: string; to: string; count: string }>>;
  perWatch: { watchId: string; label: string; chainId: ChainId; severity: Severity; lines: string[]; actions: { label: string; href: string }[] }[];
  pagedCount: number; deferredCount: number;
  /** Sleep policy of the session ("page-all" pages warnings too, so pagedCount is not only CRITICAL). */
  policy?: SleepSession["policy"];
  brief: { text: string; source: "deterministic" | "0g-compute" | "anthropic"; model: string | null };
}

export interface PagerGlobal {
  v: 1;
  tickCount: number;
  cursor: Partial<Record<ChainId, string>>;       // last fully processed block per chain
  parity: { driftSince: number | null; lastDelta: string | null; lastSpreadBps: number | null };
  lastTickAt: number | null;
  lastHash: string | null;
}

export interface TickSummary {
  tickId: string; reason: string; startedAt: number; durationMs: number;
  skipped?: "locked" | "no-storage" | "no-watches";
  chains: Partial<Record<ChainId, { from: string; to: string; gapBlocks: string; ok: boolean; error?: string }>>;
  watches: number; evaluated: number; alerts: number; deferred: number;
  deliveries: { ok: number; failed: number }; digests: number; scans: number;
  prevHash: string | null; hash: string;          // sha256(prevHash + JSON(summary sans hash)) → tamper-evident log
}

/* ---------------- API views (spec section 13) ---------------- */

/** Public projection of a watch: config plus display-ready state. Never includes `seen` / `cooldownUntil`. */
export type WatchView = Watch & {
  status: "pending" | "ok" | "alerting" | "error";
  state: {
    lastCheckedAt: number | null;
    lastCheckedBlock: string | null;
    lastError: string | null;
    lastAlert: WatchState["lastAlert"];
    alertCount: number;
    metrics: Record<string, string>;               // display-ready, e.g. "liquidity": "−0.4% vs armed"
  };
};

/** Public projection of a desk. The webhook URL itself is reduced to its host; the HMAC secret only on request. */
export interface DeskPublic {
  id: string;
  createdAt: number;
  label: string | null;
  storage: "upstash" | "memory";
  watchCount: number;
  limits: { maxWatches: number };
  policy: Desk["policy"];
  system?: boolean;
  channels: {
    telegram: { linked: boolean; username: string | null; chatType: NonNullable<Desk["channels"]["telegram"]>["chatType"];
                verified: boolean; disabledReason: string | null } | null;
    webhook: { host: string; kind: NonNullable<Desk["channels"]["webhook"]>["kind"]; failures: number;
               disabledReason: string | null; secret?: string } | null;
  };
}

/** Public projection of a sleep session (no snapshot internals). */
export interface SleepPublic {
  startedAt: number;
  wakeAt: number;
  tz: string | null;
  policy: SleepSession["policy"];
  deferredCount: number;
  pagedCount: number;
}
