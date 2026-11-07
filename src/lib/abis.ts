import { parseAbi } from "viem";

/**
 * Minimal ABIs used by Kestrel. Every Vibestarter fragment below is copied from the
 * Blockscout-verified deployed ABI bundle in `docs/contracts/vibestarter-base.json`
 * (note: tranche indexes are `uint8` on the deployed escrow — selectors differ from uint256).
 */

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

export const OWNABLE_ABI = parseAbi([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
]);

export const PERMIT2_ABI = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function lockdown((address token, address spender)[] approvals) external",
]);

export const AERODROME_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function factory() view returns (address)",
  "function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
]);

export const AERODROME_FACTORY_ABI = parseAbi([
  "function getFee(address pool, bool _stable) view returns (uint256)",
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
]);

export const AERODROME_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

export const UNISWAP_V3_POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
]);

export const UNISWAP_V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

export const SAFE_MULTISIG_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);

export const VIBES_ESCROW_FACTORY_ABI = parseAbi([
  "function getAllEscrows() view returns (address[])",
  "function totalEscrows() view returns (uint256)",
  "function isEscrow(address escrow) view returns (bool)",
]);

export const VIBES_ESCROW_ABI = parseAbi([
  "struct Campaign { address founder; address token; uint8 raiseType; uint256 goal; uint256 softCap; uint256 deadline; uint256 raiseStart; uint256 totalRaised; uint256 totalCommitted; uint256 startTime; uint8 nextTranche; uint8 state; bytes32 refundMerkleRoot; uint256 snapshotBlock; }",
  "struct Challenge { address challenger; string reason; uint256 amount; uint256 tranche; uint256 timestamp; uint8 state; }",
  "function getCampaign() view returns (Campaign)",
  "function getActiveChallenge() view returns (Challenge)",
  "function getEscrowBalance() view returns (uint256)",
  "function effectiveRaised() view returns (uint256)",
  "function getTotalTranches() pure returns (uint8)",
  "function getTrancheAmount(uint8 _tranche) view returns (uint256)",
  "function getTrancheUnlockTime(uint8 _tranche) view returns (uint256)",
  "function trancheClaimed(uint8) view returns (bool)",
  "function trancheRequestedAt(uint8) view returns (uint256)",
  "function trancheChallenged(uint8) view returns (bool)",
  "function getChallengeThreshold(uint8 tranche) pure returns (uint256)",
  "function lpCreated() view returns (bool)",
  "function lpWithdrawn() view returns (bool)",
  "function allTranchesClaimed() view returns (bool)",
  "function getCurrentTime() view returns (uint256)",
  "function CHALLENGE_WINDOW() view returns (uint256)",
]);

export const VIBES_REGISTRY_ABI = parseAbi([
  "function isRegistered(address token) view returns (bool)",
  "function founderOf(address token) view returns (address)",
  "function capsuleHashOf(address token) view returns (bytes32)",
]);

/** USDC (FiatTokenV2) EIP-3009 surface used to verify x402 "exact" payments. */
export const USDC_EIP3009_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
