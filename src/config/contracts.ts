import { type Address } from "viem";

/**
 * Live-Verified Mainnet Contract & Pool Addresses (Base 8453 & Robinhood Chain 4663)
 * Verified against Mainnet RPCs on 2026-11-04.
 */
export const CONTRACTS = {
  base: {
    chainId: 8453,
    weth: "0x4200000000000000000000000000000000000006" as Address,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,

    // Vibestarter Token & OFT Bridge on Base
    vibesToken: "0xefFC8815487084a97edfdfF968b56Ea123421Acb" as Address,
    vibesBridgeAdapter: "0x408021Cb4ef1033675C70CF97788F3E03f45A381" as Address,
    vibesAerodromePool: "0x07F78058685b75F89288f025a0a154A96021Ac45" as Address, // token0: WETH, token1: VIBES

    // Aerodrome (verified live: VIBES pool.factory() == aerodromeFactory; router getAmountsOut quotes VIBES→WETH→USDC)
    aerodromeFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address,
    aerodromeRouter: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address,

    // Vibestarter Core Protocol Contracts (Base Mainnet)
    vibesLaunchRouterV2: "0x783a7DB4113DC35A87dA43319af3cA7E6428f4BC" as Address,
    vibesTranchEscrowFactory: "0x36C7e2d87F4E2d33b70304EbaA81eE88CB04Bf86" as Address,
    vibesTranchEscrowImpl: "0xcBe7e9E13576838eb4B55d0793Fd1CFFC1Dea43d" as Address,
    vibesRegistry: "0x66b74176F53d3081a87F75e10aD6cF554174Aef9" as Address,
    vibesTokenFactory: "0x3671DBD5CFaF1D0D5c15a18b65F2CC7AcC7faE29" as Address,

    // Live Funded Genesis Raise Escrow on Base (123.46 ETH raised, 214 backers)
    vibesGenesisEscrow: "0x0e9bf34baed84a80d7647dafe4db52169147c911" as Address,

    // Common Spenders to Scan for Wallet Approval Exposure on Base
    commonSpenders: [
      {
        name: "Permit2 (Universal)",
        address: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
      },
      {
        name: "Uniswap Universal Router (Base)",
        address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" as Address,
      },
      {
        name: "Aerodrome Router v2",
        address: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address,
      },
      {
        name: "1inch Aggregation Router v6",
        address: "0x111111125421cA6dc452d289314280a0f8842A65" as Address,
      },
      {
        name: "Vibestarter Base OFT Bridge Adapter",
        address: "0x408021Cb4ef1033675C70CF97788F3E03f45A381" as Address,
      },
    ],
  },

  robinhood: {
    chainId: 4663,
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Address,

    // Vibestarter Token & OFT Reserve Adapter on Robinhood Chain
    vibesToken: "0x9A73D60b9c8C2d330EB6D885E69fCc1399c33C18" as Address,
    vibesReserveAdapter: "0x37F26e3025b3DC50e0EE9f610D386803B42D0685" as Address,
    vibesUniswapV3Pool: "0x3A9BFEc8ae16Bf023C3119C38A04Fb054A19bAc5" as Address, // 1% tier; token0: WETH, token1: VIBES
  },
} as const;

/** Tokens whose balances & approvals are scanned for every wallet target. */
export const TRACKED_TOKENS: Record<8453 | 4663, readonly Address[]> = {
  8453: [CONTRACTS.base.vibesToken, CONTRACTS.base.weth, CONTRACTS.base.usdc],
  4663: [CONTRACTS.robinhood.vibesToken, CONTRACTS.robinhood.weth],
};

/** Spenders checked for ERC-20 allowance exposure on each chain. */
export const SPENDERS: Record<8453 | 4663, readonly { name: string; address: Address }[]> = {
  8453: CONTRACTS.base.commonSpenders,
  4663: [
    { name: "Permit2 (Universal)", address: CONTRACTS.base.permit2 },
    { name: "Vibestarter RH OFT Reserve Adapter", address: CONTRACTS.robinhood.vibesReserveAdapter },
  ],
};

/** Labels for well-known infrastructure addresses (excluded from whale detection). */
export const KNOWN_LABELS: Record<string, string> = {
  [CONTRACTS.base.vibesBridgeAdapter.toLowerCase()]: "Base OFT Bridge Adapter",
  [CONTRACTS.base.vibesAerodromePool.toLowerCase()]: "Aerodrome WETH/VIBES Pool",
  [CONTRACTS.base.vibesGenesisEscrow.toLowerCase()]: "Vibestarter Genesis Escrow",
  [CONTRACTS.base.vibesLaunchRouterV2.toLowerCase()]: "Vibestarter Launch Router V2",
  [CONTRACTS.robinhood.vibesReserveAdapter.toLowerCase()]: "RH OFT Reserve Adapter",
  [CONTRACTS.robinhood.vibesUniswapV3Pool.toLowerCase()]: "RH Uniswap v3 WETH/VIBES Pool",
  "0x0000000000000000000000000000000000000000": "Zero Address",
  "0x000000000000000000000000000000000000dead": "Burn Address",
};

export const VIBESTARTER_PUBLIC_ENDPOINTS = {
  appUrl: "https://app.vibestarter.xyz",
  mcpUrl: "https://app.vibestarter.xyz/mcp",
  openApiUrl: "https://app.vibestarter.xyz/api/openapi.json",
  contractsBundleUrl: "https://app.vibestarter.xyz/api/contracts.json",
  campaignsApiUrl: "https://app.vibestarter.xyz/api/campaigns",
  genesisCampaignApiUrl: "https://app.vibestarter.xyz/api/campaigns/by-tx/vibes",
  statsApiUrl: "https://app.vibestarter.xyz/api/stats",
} as const;

/**
 * 1-Click Live Mainnet Presets for Zero-Auth Landing Experience
 * Judges, AI crawlers (Fundable), and $VIBES voters can click any preset instantly.
 */
export const LIVE_DEMO_PRESETS = [
  {
    id: "vibes-cross-chain",
    label: "$VIBES Cross-Chain & Pool Sentinel",
    badge: "Base ↔ Robinhood",
    chainId: 8453,
    targetAddress: "0xefFC8815487084a97edfdfF968b56Ea123421Acb" as Address,
    kind: "token" as const,
    description: "Live OFT 1:1 reserve check + Base Aerodrome vs Robinhood Uniswap v3 spread & rug stress test.",
  },
  {
    id: "vibes-genesis-escrow",
    label: "Vibestarter Genesis Escrow (123.46 ETH)",
    badge: "Backer Shield",
    chainId: 8453,
    targetAddress: "0x0e9bf34baed84a80d7647dafe4db52169147c911" as Address,
    kind: "escrow" as const,
    description: "Live tranche schedule, 72-hour backer challenge countdown, permanent LP lock & Origin Capsule check.",
  },
  {
    id: "base-aerodrome-pool",
    label: "Aerodrome WETH/VIBES Pool",
    badge: "LP Stress Test",
    chainId: 8453,
    targetAddress: "0x07F78058685b75F89288f025a0a154A96021Ac45" as Address,
    kind: "pool" as const,
    description: "Interactive whale dump & liquidity removal slippage simulator from live Base reserves.",
  },
  {
    id: "robinhood-univ3-pool",
    label: "Robinhood Chain Uniswap v3 Pool",
    badge: "Chain 4663",
    chainId: 4663,
    targetAddress: "0x3A9BFEc8ae16Bf023C3119C38A04Fb054A19bAc5" as Address,
    kind: "pool" as const,
    description: "Live slot0 sqrtPriceX96, active tick liquidity, and cross-venue spread vs Base.",
  },
] as const;
