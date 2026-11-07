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

export interface SpenderInfo {
  name: string;
  address: Address;
  /** Also checked for Permit2 sub-allowances (routers that pull tokens through Permit2). */
  permit2?: boolean;
  category?: "permit2" | "dex" | "aggregator" | "bridge" | "nft" | "lending" | "vibestarter";
}

/**
 * Curated ERC-20s scanned (balanceOf + allowance) for every Base wallet. Every address below was verified
 * live on 2026-11-07 (eth_getCode non-empty + symbol()/decimals() answered as labelled). Ordered by
 * relevance: consumers that slice the list (e.g. rescue re-checks) keep the most important ones.
 */
export const BASE_TRACKED_TOKENS: readonly { symbol: string; address: Address }[] = [
  { symbol: "VIBES", address: CONTRACTS.base.vibesToken },
  { symbol: "WETH", address: CONTRACTS.base.weth },
  { symbol: "USDC", address: CONTRACTS.base.usdc },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
  { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
  { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" },
  { symbol: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
  { symbol: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
  { symbol: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
  { symbol: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A" },
  { symbol: "rETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c" },
  { symbol: "ezETH", address: "0x2416092f143378750bb29b79eD961ab195CcEea5" },
  { symbol: "wrsETH", address: "0xEDfa23602D0EC14714057867A78d01e94176BEA0" },
  { symbol: "superOETHb", address: "0xDBFeFD2e8460a6Ee4955A68582F85708BAEA60A3" },
  { symbol: "LBTC", address: "0xecAc9C5F704e954931349Da37F60E39f515c11c1" },
  { symbol: "tBTC", address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b" },
  { symbol: "cbXRP", address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af" },
  { symbol: "cbDOGE", address: "0xcbD06E5A2B0C65597161de254AA074E489dEb510" },
  { symbol: "USDS", address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc" },
  { symbol: "sUSDS", address: "0x5875eEE11Cf8398102FdAd704C9E96607675467a" },
  { symbol: "GHO", address: "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee" },
  { symbol: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34" },
  { symbol: "sUSDe", address: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" },
  { symbol: "USDz", address: "0x04D5ddf5f3a8939889F11E97f8c4BB48317F1938" },
  { symbol: "MORPHO", address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842" },
  { symbol: "WELL", address: "0xA88594D404727625A9437C3f886C7643872296AE" },
  { symbol: "ZORA", address: "0x1111111111166b7FE7bd91427724B487980aFc69" },
  { symbol: "BRETT", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
  { symbol: "TOSHI", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" },
  { symbol: "KAITO", address: "0x98d0baa52b2D063E780DE12F615f963Fe8537553" },
  { symbol: "AIXBT", address: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825" },
  { symbol: "SPX", address: "0x50dA645f148798F68EF2d7dB7C1CB22A6819bb2C" },
  { symbol: "HIGHER", address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe" },
];

/**
 * Curated Robinhood Chain ERC-20s (verified live 2026-11-07: symbol()/decimals() answered; USDG and NVDA
 * were the most-approved tokens in a live Approval-log sample).
 */
export const ROBINHOOD_TRACKED_TOKENS: readonly { symbol: string; address: Address }[] = [
  { symbol: "VIBES", address: CONTRACTS.robinhood.vibesToken },
  { symbol: "WETH", address: CONTRACTS.robinhood.weth },
  { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
];

/** Tokens whose balances & approvals are scanned for every wallet target. */
export const TRACKED_TOKENS: Record<8453 | 4663, readonly Address[]> = {
  8453: BASE_TRACKED_TOKENS.map((t) => t.address),
  4663: ROBINHOOD_TRACKED_TOKENS.map((t) => t.address),
};

/**
 * Base spenders checked for ERC-20 allowance exposure. Every address verified live on 2026-11-07 (non-empty
 * bytecode; routers cross-checked via factory()/poolManager()/WETH9() where exposed). Ordered by how often
 * they hold real approvals (consumers that slice the list keep the most important ones).
 */
export const BASE_SPENDERS: readonly SpenderInfo[] = [
  { name: "Permit2 (Universal)", address: CONTRACTS.base.permit2, category: "permit2" },
  { name: "Uniswap Universal Router v2 (v4)", address: "0x6fF5693b99212Da76ad316178A184AB56D299b43", permit2: true, category: "dex" },
  { name: "Uniswap SwapRouter02", address: "0x2626664c2603336E57B271c5C0b26F421741e481", category: "dex" },
  { name: "Uniswap Universal Router v1.2", address: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", permit2: true, category: "dex" },
  { name: "Aerodrome Router v2", address: CONTRACTS.base.aerodromeRouter, category: "dex" },
  { name: "Aerodrome Universal Router", address: "0x6Cb442acF35158D5eDa88fe602221b67B400Be3E", permit2: true, category: "dex" },
  { name: "Aerodrome Slipstream SwapRouter", address: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5", category: "dex" },
  { name: "Aerodrome Slipstream SwapRouter (factory 0xaDe6…)", address: "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D", category: "dex" },
  { name: "Aerodrome Slipstream Position NFT", address: "0x827922686190790b37229fd06084350E74485b72", category: "dex" },
  { name: "Aerodrome Slipstream Position NFT (factory 0xaDe6…)", address: "0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F", category: "dex" },
  { name: "1inch Aggregation Router v6", address: "0x111111125421cA6dc452d289314280a0f8842A65", category: "aggregator" },
  { name: "1inch Aggregation Router v5", address: "0x1111111254EEB25477B68fb85Ed929f73A960582", category: "aggregator" },
  { name: "0x AllowanceHolder", address: "0x0000000000001fF3684f28c67538d4D072C22734", category: "aggregator" },
  { name: "0x Exchange Proxy", address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", category: "aggregator" },
  { name: "Odos Router v2", address: "0x19cEeAd7105607Cd444F5ad10dd51356436095a1", category: "aggregator" },
  { name: "Odos Router v3", address: "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05", category: "aggregator" },
  { name: "KyberSwap MetaAggregationRouter v2", address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", category: "aggregator" },
  { name: "CoW Protocol GPv2VaultRelayer", address: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110", category: "aggregator" },
  { name: "Velora (ParaSwap) Augustus v6.2", address: "0x6A000F20005980200259B80c5102003040001068", category: "aggregator" },
  { name: "ParaSwap Augustus v5", address: "0x59C7C832e96D2568bea6db468C1aAdcbbDa08A52", category: "aggregator" },
  { name: "OKX DEX Token Approve", address: "0x57df6092665eb6058DE53939612413ff4B09114E", category: "aggregator" },
  { name: "MetaMask Swaps Router", address: "0x9dDA6Ef3D919c9bC8885D5560999A3640431e8e6", category: "aggregator" },
  { name: "Rainbow Router", address: "0x00000000009726632680FB29d3F7A9734E3010E2", category: "aggregator" },
  { name: "Bebop Settlement", address: "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F", category: "aggregator" },
  { name: "Enso Router", address: "0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E", category: "aggregator" },
  { name: "PancakeSwap Smart Router", address: "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", category: "dex" },
  { name: "Uniswap v3 Position Manager", address: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", category: "dex" },
  { name: "Uniswap v4 Position Manager", address: "0x7C5f5A4bBd8fD63184577525326123B519429bDc", permit2: true, category: "dex" },
  { name: "Uniswap v2 Router02", address: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", category: "dex" },
  { name: "Uniswap Universal Router v1", address: "0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC", permit2: true, category: "dex" },
  { name: "Balancer V2 Vault", address: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", category: "dex" },
  { name: "Balancer V3 Vault", address: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", category: "dex" },
  { name: "LI.FI Diamond", address: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", category: "bridge" },
  { name: "Relay Approval Proxy", address: "0xBBbfD134E9b44BfB5123898BA36b01dE7ab93d98", category: "bridge" },
  { name: "Relay Router", address: "0xF5042e6ffaC5a625D4E7848e0b01373D8eB9e222", category: "bridge" },
  { name: "Across SpokePool", address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", category: "bridge" },
  { name: "Stargate v2 USDC Pool", address: "0x27a16dc786820B16E5c9028b75B99F6f604b5d26", category: "bridge" },
  { name: "Socket Gateway (Bungee)", address: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", category: "bridge" },
  { name: "deBridge DLN Source", address: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", category: "bridge" },
  { name: "Seaport 1.6", address: "0x0000000000000068F116a894984e2DB1123eB395", category: "nft" },
  { name: "OpenSea Conduit", address: "0x1E0049783F008A0085193E00003D00cd54003c71", category: "nft" },
  { name: "Aave v3 Pool", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", category: "lending" },
  { name: "Morpho Blue", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", category: "lending" },
  { name: "Morpho General Adapter", address: "0xb98c948CFA24072e58935BC004a8A7b376AE746A", category: "lending" },
  { name: "Morpho Bundler v3", address: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4", category: "lending" },
  { name: "Moonwell mUSDC", address: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", category: "lending" },
  { name: "Moonwell mWETH", address: "0x628ff693426583D9a7FB391E54366292F509D457", category: "lending" },
  { name: "Compound v3 cUSDCv3", address: "0xb125E6687d4313864e53df431d5425969c15Eb2F", category: "lending" },
  { name: "Compound v3 cWETHv3", address: "0x46e6b214b524310239732D51387075E0e70970bf", category: "lending" },
  { name: "Vibestarter Base OFT Bridge Adapter", address: CONTRACTS.base.vibesBridgeAdapter, category: "vibestarter" },
  { name: "Vibestarter Launch Router V2", address: CONTRACTS.base.vibesLaunchRouterV2, category: "vibestarter" },
];

/**
 * Robinhood Chain spenders, identified live on 2026-11-07 from an Approval-log sample (most-approved spenders)
 * and cross-checked onchain: SwapRouter factory() == the verified VIBES pool's Uniswap v3 factory, the v4 router
 * exposes poolManager(), the Slipstream NFPM answers name() "Slipstream V3 Deposit".
 */
export const ROBINHOOD_SPENDERS: readonly SpenderInfo[] = [
  { name: "Permit2 (Universal)", address: CONTRACTS.base.permit2, category: "permit2" },
  { name: "Uniswap v3 SwapRouter (RH)", address: "0xCaf681a66D020601342297493863E78C959E5cb2", category: "dex" },
  { name: "Uniswap v4 Router (RH)", address: "0x08E52564Bad99E05a694b4809F397edcA417A080", permit2: true, category: "dex" },
  { name: "Permit2-based Router (RH)", address: "0x069A1975C3a67168767581613F91eE09902Ae8c6", permit2: true, category: "dex" },
  { name: "Aerodrome Slipstream Position NFT (RH)", address: "0x4857DB576eE0e45F10525eC59527BfD10beeC60b", category: "dex" },
  { name: "0x AllowanceHolder", address: "0x0000000000001fF3684f28c67538d4D072C22734", category: "aggregator" },
  { name: "KyberSwap MetaAggregationRouter v2", address: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", category: "aggregator" },
  { name: "Vibestarter RH OFT Reserve Adapter", address: CONTRACTS.robinhood.vibesReserveAdapter, category: "vibestarter" },
];

/** Spenders checked for ERC-20 allowance exposure on each chain. */
export const SPENDERS: Record<8453 | 4663, readonly SpenderInfo[]> = {
  8453: BASE_SPENDERS,
  4663: ROBINHOOD_SPENDERS,
};

/** Spenders checked for Permit2 sub-allowances (Permit2.allowance(owner, token, spender)) on each chain. */
export const PERMIT2_SPENDERS: Record<8453 | 4663, readonly SpenderInfo[]> = {
  8453: BASE_SPENDERS.filter((s) => s.permit2),
  4663: ROBINHOOD_SPENDERS.filter((s) => s.permit2),
};

/** Lower-cased address → spender name, both chains (for labelling spenders found in logs). */
export const SPENDER_LABELS: Record<string, string> = Object.fromEntries(
  [...ROBINHOOD_SPENDERS, ...BASE_SPENDERS].map((s) => [s.address.toLowerCase(), s.name])
);

/**
 * Public Panic Bunker demo target (non-personal): the Vibestarter team Safe on Base. Verified live 2026-11-07:
 * Safe v1.4.1, 2-of-3; owner of VibesLaunchRouterV2 / VibesRegistry / Base OFT adapter, launch fee recipient;
 * holds VIBES; UNLIMITED ERC-20 approvals: USDC → CoW GPv2VaultRelayer, WETH → CoW GPv2VaultRelayer,
 * EURC → CoW GPv2VaultRelayer, USDC → Aave v3 Pool. Approvals can change at any time — the scan reads them live.
 * Not added to LIVE_DEMO_PRESETS (kind "wallet" would widen that union); wire it where the UX wants it.
 */
export const PANIC_BUNKER_DEMO_PRESET = {
  id: "vibestarter-team-safe",
  label: "Vibestarter Team Safe (2-of-3)",
  badge: "Panic Bunker",
  chainId: 8453,
  targetAddress: "0x3CFDbf58Ed6866cD45Fb8B273EBA32a6259fFee0" as Address,
  kind: "wallet" as const,
  description: "Protocol treasury Safe with live unlimited approvals (CoW, Aave) — see exactly what a 1-click batch revoke would build.",
} as const;

/** Non-personal smart-wallet demo targets found during the 2026-11-07 approval sweep (verified live). */
export const DEMO_WALLETS = {
  /** Vibestarter team Safe (2-of-3): owner of VibesLaunchRouterV2 / VibesRegistry / Base OFT adapter + launch fee recipient. */
  vibestarterTeamSafe: "0x3CFDbf58Ed6866cD45Fb8B273EBA32a6259fFee0" as Address,
  /** DEGEN token owner Safe (2-of-3). */
  degenOwnerSafe: "0x704Ec5C12Ca20a293C2C0B72B22619A4231f3c0d" as Address,
} as const;

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
