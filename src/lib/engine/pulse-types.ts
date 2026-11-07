/**
 * JSON contract of GET /api/pulse (the Sentinel Watch hero feed). Types only: shared by the server engine
 * (engine/pulse.ts), the route, and the client replay / face components. Block numbers are decimal strings.
 */

export type PulseSpan = "short" | "long";

export type EventKind =
  | "P2_GRANT"
  | "P2_MAX"
  | "P2_REVOKE"
  | "VIBES_SWAP"
  | "VIBES_LP"
  | "VIBES_TRANSFER"
  | "VIBES_APPROVAL"
  | "OFT_SENT"
  | "OFT_RECEIVED"
  | "VIBESTARTER"
  | "VIBES_LOG";

export interface PulseEvent {
  /** `${chainId}:${tx}:${logIndex}` — one real log. */
  id: string;
  chainId: 8453 | 4663;
  block: string;
  tx: string;
  logIndex: number;
  kind: EventKind;
  /** True for a watched $VIBES / OFT / Vibestarter address (collapsed to one per tx). */
  contact: boolean;
  token: string | null;
  symbol: string | null;
  spender: string | null;
  spenderLabel: string | null;
  /** Plain text, built from verified config labels or short addresses. */
  summary: string;
}

export interface PulseAnchor {
  block: string;
  timeMs: number;
  /** True when timeMs is the block's own timestampMs (Base); false = interpolated (Robinhood). */
  exact: boolean;
}

export interface PulseChain {
  chainId: 8453 | 4663;
  ok: boolean;
  logsOk: boolean;
  error: string | null;
  from: string | null;
  to: string | null;
  /**
   * Per-block gas fraction, oldest → newest; length === to - from + 1. Base: gasUsed / gasLimit (4 dp).
   * Robinhood: gasUsed ÷ (14M gas/s · cadence), de-accumulated from Nitro's per-second running sum (5 dp, may
   * exceed 1). null = unknown for that block (never guessed).
   */
  gas: (number | null)[];
  baseFeeWei: string | null;
  anchor: PulseAnchor | null;
  cadenceMs: number;
  cadenceMeasured: boolean;
  /** Logs were read over [from, logsTo]. */
  logsTo: string | null;
  watched: number;
}

export interface PulseParity {
  /** VERIFIED (Δ 0) · IN_FLIGHT / OVER_BACKED / BACKED (locked > circulating, holders covered) · DRIFT (confirmed unbacked) · UNKNOWN. */
  status: "VERIFIED" | "IN_FLIGHT" | "OVER_BACKED" | "BACKED" | "DRIFT" | "UNKNOWN";
  deltaRaw: string | null;
  baseBlock: string | null;
  rhBlock: string | null;
  fetchedAt: string;
}

export interface PulseContact {
  chainId: 8453 | 4663;
  block: string;
  tx: string;
  kind: EventKind;
  label: string;
  /** Unix seconds of the contact's block. */
  timestamp: number;
}

export interface PulseScannedRange {
  from: string | null;
  to: string | null;
  complete: boolean;
}

export interface PulseLastContact {
  /** null = no contact in the scanned ranges. */
  contact: PulseContact | null;
  scanned: { base: PulseScannedRange; rh: PulseScannedRange };
}

export interface Pulse {
  v: 1;
  span: PulseSpan;
  builtAt: number;
  chains: { base: PulseChain; rh: PulseChain };
  events: PulseEvent[];
  parity: PulseParity | null;
  /** null = the history scan has not finished yet. */
  lastContact: PulseLastContact | null;
}
