import { type Address, parseAbi, toEventSelector } from "viem";
import { CONTRACTS } from "@/config/contracts";
import type { ChainId } from "@/lib/engine/types";
import type { Hex } from "./types";

/**
 * Night-Shift Pager engine constants: event topics, legacy proxy slots, LayerZero wiring and the
 * minimal ABIs the batched probe pass needs. Topics are derived from canonical signatures at module
 * load (never hand-typed); the hex prefixes in the comments were verified against live logs.
 *
 * CLIENT-SAFE (viem + @/config only): imported by the client-safe `rules.ts` catalogue. Keep node:* / KV out.
 */
export const T = {
  ERC20_APPROVAL: toEventSelector("event Approval(address indexed owner, address indexed spender, uint256 value)"), // 0x8c5be1e5…b925 (ERC-721 Approval shares topic0, 4 topics)
  APPROVAL_FOR_ALL: toEventSelector("event ApprovalForAll(address indexed owner, address indexed operator, bool approved)"), // 0x17307eab…6c31
  PERMIT2_APPROVAL: toEventSelector("event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)"), // 0xda9fa7c1…036b
  PERMIT2_PERMIT: toEventSelector("event Permit(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration, uint48 nonce)"), // 0xc6a377bf…08ec
  TRANSFER: toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)"), // 0xddf252ad…b3ef
  UPGRADED: toEventSelector("event Upgraded(address indexed implementation)"), // 0xbc7cd75a…2d3b
  ADMIN_CHANGED: toEventSelector("event AdminChanged(address previousAdmin, address newAdmin)"), // 0x7e644d79…798f
  BEACON_UPGRADED: toEventSelector("event BeaconUpgraded(address indexed beacon)"), // 0x1cf3b03a…5d3e
  OWNERSHIP_TRANSFERRED: toEventSelector("event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"), // 0x8be0079c…57e0
  PAUSED: toEventSelector("event Paused(address account)"), // 0x62e78cea…a258
  UNPAUSED: toEventSelector("event Unpaused(address account)"), // 0x5db9ee0a…73aa
  PEER_SET: toEventSelector("event PeerSet(uint32 eid, bytes32 peer)"), // 0x238399d4…b98b
  AERO_BURN: toEventSelector("event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1)"), // 0x5d624aa9…6fa2 (live)
  V3_BURN: toEventSelector("event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)"), // 0x0c396cd9…982c
} as const;

export const ADMIN_TOPICS: Hex[] = [T.UPGRADED, T.ADMIN_CHANGED, T.BEACON_UPGRADED, T.OWNERSHIP_TRANSFERRED, T.PAUSED, T.UNPAUSED, T.PEER_SET];

/** EIP-1967 slots (re-exported shape) plus the legacy ZeppelinOS slots used by USDC on Base (verified live). */
export const SLOTS = {
  eip1967Impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  ozImpl: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3", // keccak("org.zeppelinos.proxy.implementation")
  ozAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b", // keccak("org.zeppelinos.proxy.admin")
} as const satisfies Record<string, Hex>;
export type ProxySlotName = keyof typeof SLOTS;
export const PROXY_SLOT_NAMES = Object.keys(SLOTS) as ProxySlotName[];
export const OZ_IMPL_SLOT = SLOTS.ozImpl;
export const OZ_ADMIN_SLOT = SLOTS.ozAdmin;

/** LayerZero V2 endpoint ids, verified via live endpoint.eid() and peers() reads. */
export const LZ_EID: Record<ChainId, number> = { 8453: 30184, 4663: 30416 };

export interface BridgeLane { chainId: ChainId; adapter: Hex; eid: number; expectedPeer: Hex }

/** $VIBES OFT mesh: each adapter, the REMOTE eid it peers with, and the peer it must point at (verified 2026-11-07). */
export const VIBES_BRIDGE: BridgeLane[] = [
  { chainId: 8453, adapter: "0x408021Cb4ef1033675C70CF97788F3E03f45A381", eid: 30416, expectedPeer: "0x37F26e3025b3DC50e0EE9f610D386803B42D0685" },
  { chainId: 4663, adapter: "0x37F26e3025b3DC50e0EE9f610D386803B42D0685", eid: 30184, expectedPeer: "0x408021Cb4ef1033675C70CF97788F3E03f45A381" },
];

/** Owner + LayerZero delegate of both adapters (2-of-3 Safe on both chains, verified live). */
export const VIBES_ADMIN_SAFE: Hex = "0x3CFDbf58Ed6866cD45Fb8B273EBA32a6259fFee0";

/** Both VIBES tokens, both pools, both adapters: these watches get parity / spread / bridge rules. */
export const VIBES_SET = new Set(
  [
    CONTRACTS.base.vibesToken,
    CONTRACTS.robinhood.vibesToken,
    CONTRACTS.base.vibesAerodromePool,
    CONTRACTS.robinhood.vibesUniswapV3Pool,
    CONTRACTS.base.vibesBridgeAdapter,
    CONTRACTS.robinhood.vibesReserveAdapter,
  ].map((a) => a.toLowerCase())
);

export const WETH: Record<ChainId, Address> = { 8453: CONTRACTS.base.weth, 4663: CONTRACTS.robinhood.weth };

/** Tokens far too busy for per-tick Transfer scans (Base WETH alone: ~3k Transfer logs / 5 min). */
export const HIGH_VOLUME_TOKENS = new Set([
  "0x4200000000000000000000000000000000000006",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
]);

export const PERMIT2: Address = CONTRACTS.base.permit2; // same address on Base and Robinhood Chain (verified deployed)
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Max log window per tick: Base ≈ 33 min at 200 ms blocks (publicnode cap is 50k); RH ≈ 42 min (topic-only cap 30k). */
export const MAX_RANGE: Record<ChainId, bigint> = { 8453: 10_000n, 4663: 25_000n };
/** Hard per-request block span for eth_getLogs chunking. */
export const LOG_CHUNK: Record<ChainId, bigint> = { 8453: 45_000n, 4663: 25_000n };
/** Max OR'd topic values (e.g. watched owners) per eth_getLogs request (100 verified OK on both RPCs). */
export const LOG_FILTER_FANOUT = 100;
/** Max contract addresses per eth_getLogs request: base-rpc.publicnode.com rejects > 10 ("A maximum of 10 addresses is allowed"). */
export const LOG_ADDRESS_FANOUT: Record<ChainId, number> = { 8453: 10, 4663: 100 };
/** Max logs kept per category per tick (protects the evaluator and Redis from spam tokens). */
export const LOG_CAP = 2_000;

export const UNLIMITED_THRESHOLD = 1n << 128n;
/** WETH depth floors (18 decimals). */
export const DUST_POOL_WETH = 5n * 10n ** 16n; // 0.05 WETH: LP rule ignores dust pools
export const PRICE_RULE_MIN_WETH = 5n * 10n ** 17n; // 0.5 WETH: price rule ignores thin pools
export const POOL_SAMPLES_MAX = 40;
export const SEEN_MAX = 100;

export const MULTICALL3_ABI = parseAbi(["function getEthBalance(address addr) view returns (uint256 balance)"]);
export const PEERS_ABI = parseAbi(["function peers(uint32 eid) view returns (bytes32)"]);
export const PAUSABLE_ABI = parseAbi(["function paused() view returns (bool)"]);

/** VibesOFTAdapter governance / credit-budget views (Sourcify-verified source; identical runtime on RH). */
export const OFT_ADAPTER_ABI = parseAbi([
  "function peers(uint32 eid) view returns (bytes32 peer)",
  "function creditBudget(uint32 _srcEid) view returns (uint256 inFlight, uint256 canCredit)",
  "function rateLimits(uint32 eid) view returns (uint192 amountInFlight, uint64 lastUpdated, uint192 limit, uint64 window)",
  "function paused() view returns (bool)",
  "function pauser() view returns (address)",
  "function owner() view returns (address)",
]);

/** Event ABIs used only for decoding logs fetched with raw (OR'd) filters. */
export const PAGER_EVENTS_ABI = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Credit-budget headroom below this share of the limit pages a warning (oft.md §6 `credit-headroom-low`). */
export const CREDIT_HEADROOM_WARN_BPS = 2_500;
export const CREDIT_HEADROOM_REARM_BPS = 4_000;

/** Inbound credit budgets are keyed by the SOURCE eid and enforced on the DESTINATION adapter (oft.md §2). */
export const BRIDGE_LANE_NAME: Record<ChainId, string> = {
  8453: "Robinhood → Base lane",
  4663: "Base → Robinhood lane",
};
export const BRIDGE_LANE_ENFORCER: Record<ChainId, string> = {
  8453: "enforced on the Base adapter",
  4663: "enforced on the Robinhood adapter",
};
