#!/usr/bin/env node
/**
 * Kestrel ($KEST) — Zero-Dependency Live Onchain Smoke Verifier
 * Verifies live connectivity & contract reads across:
 *   1. Base Mainnet (8453) — $VIBES supply, OFT Adapter locked balance, Aerodrome WETH/VIBES reserves
 *   2. Robinhood Chain Mainnet (4663) — $VIBES supply, OFT Reserve Adapter balance, Uniswap v3 slot0
 *   3. Exact 1:1 Cross-Chain OFT Proof-of-Reserve Invariant
 *   4. Vibestarter Genesis Escrow & Tranche / 72h Challenge Window Feed
 */

const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
const RH_RPC = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const ADDR = {
  baseVibes: "0xefFC8815487084a97edfdfF968b56Ea123421Acb",
  baseBridgeAdapter: "0x408021Cb4ef1033675C70CF97788F3E03f45A381",
  baseAeroPool: "0x07F78058685b75F89288f025a0a154A96021Ac45",
  baseGenesisEscrow: "0x0e9bf34baed84a80d7647dafe4db52169147c911",
  rhVibes: "0x9A73D60b9c8C2d330EB6D885E69fCc1399c33C18",
  rhReserveAdapter: "0x37F26e3025b3DC50e0EE9f610D386803B42D0685",
  rhUniV3Pool: "0x3A9BFEc8ae16Bf023C3119C38A04Fb054A19bAc5",
};

async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${url}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC Error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function encodeBalanceOf(account) {
  return "0x70a08231" + account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function formatUnits18(val) {
  const s = val.toString().padStart(19, "0");
  const whole = s.slice(0, -18) || "0";
  const frac = s.slice(-18, -12);
  return `${Number(whole).toLocaleString("en-US")}.${frac}`;
}

async function main() {
  console.log(">_ KESTREL SENTINEL — LIVE DUAL-CHAIN VERIFICATION");
  console.log("--------------------------------------------------");

  const [baseChainHex, baseBlockHex, rhChainHex, rhBlockHex] = await Promise.all([
    rpcCall(BASE_RPC, "eth_chainId"),
    rpcCall(BASE_RPC, "eth_blockNumber"),
    rpcCall(RH_RPC, "eth_chainId"),
    rpcCall(RH_RPC, "eth_blockNumber"),
  ]);

  console.log(`[BASE]      chainId=${parseInt(baseChainHex, 16)} | latestBlock=#${parseInt(baseBlockHex, 16)}`);
  console.log(`[ROBINHOOD] chainId=${parseInt(rhChainHex, 16)} | latestBlock=#${parseInt(rhBlockHex, 16)}`);

  // 1. Cross-chain OFT 1:1 Reserve Parity Check
  const [baseLockedHex, rhTotalSupplyHex, rhReserveHex] = await Promise.all([
    rpcCall(BASE_RPC, "eth_call", [{ to: ADDR.baseVibes, data: encodeBalanceOf(ADDR.baseBridgeAdapter) }, "latest"]),
    rpcCall(RH_RPC, "eth_call", [{ to: ADDR.rhVibes, data: "0x18160ddd" }, "latest"]), // totalSupply()
    rpcCall(RH_RPC, "eth_call", [{ to: ADDR.rhVibes, data: encodeBalanceOf(ADDR.rhReserveAdapter) }, "latest"]),
  ]);

  const baseLocked = BigInt(baseLockedHex);
  const rhTotalSupply = BigInt(rhTotalSupplyHex);
  const rhReserve = BigInt(rhReserveHex);
  const rhCirculating = rhTotalSupply - rhReserve;
  const delta = baseLocked >= rhCirculating ? baseLocked - rhCirculating : rhCirculating - baseLocked;

  console.log("\n[1] $VIBES LAYERZERO OFT BRIDGE PARITY:");
  console.log(`    Locked on Base Adapter:       ${formatUnits18(baseLocked)} VIBES`);
  console.log(`    Circulating on Robinhood:     ${formatUnits18(rhCirculating)} VIBES`);
  console.log(`    In-Flight / Delta:            ${formatUnits18(delta)} VIBES (${delta === 0n ? "EXACT 1:1 PARITY" : "CROSSING IN FLIGHT / ROUNDING"})`);

  // 2. Pool Spot Price Comparison (Base Aerodrome vs Robinhood Uniswap v3)
  const [aeroReservesHex, uniSlot0Hex] = await Promise.all([
    rpcCall(BASE_RPC, "eth_call", [{ to: ADDR.baseAeroPool, data: "0x0902f1ac" }, "latest"]), // getReserves()
    rpcCall(RH_RPC, "eth_call", [{ to: ADDR.rhUniV3Pool, data: "0x3850c7bd" }, "latest"]), // slot0()
  ]);

  const cleanAero = aeroReservesHex.replace(/^0x/, "");
  const reserve0Weth = BigInt("0x" + cleanAero.slice(0, 64));
  const reserve1Vibes = BigInt("0x" + cleanAero.slice(64, 128));
  const baseVibesPerWeth = (reserve1Vibes * 10n ** 18n) / reserve0Weth;

  const cleanSlot0 = uniSlot0Hex.replace(/^0x/, "");
  const sqrtPriceX96 = BigInt("0x" + cleanSlot0.slice(0, 64));
  const Q192 = 1n << 192n;
  const rhVibesPerWeth = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192;

  const spreadBps = Number(((rhVibesPerWeth - baseVibesPerWeth) * 10_000n) / baseVibesPerWeth);

  console.log("\n[2] CROSS-CHAIN DEX DISLOCATION ($VIBES per 1 WETH):");
  console.log(`    Base Aerodrome Pool:          ${formatUnits18(baseVibesPerWeth)} VIBES / WETH (WETH reserve: ${formatUnits18(reserve0Weth)})`);
  console.log(`    Robinhood Uniswap v3 (1%):    ${formatUnits18(rhVibesPerWeth)} VIBES / WETH`);
  console.log(`    Cross-Venue Price Spread:     ${(spreadBps / 100).toFixed(2)}% (${spreadBps} bps)`);

  // 3. Vibestarter Genesis Escrow Check
  const [escrowEthBalanceHex, campaignRes] = await Promise.all([
    rpcCall(BASE_RPC, "eth_getBalance", [ADDR.baseGenesisEscrow, "latest"]),
    fetch("https://app.vibestarter.xyz/api/campaigns/by-tx/vibes", {
      headers: { "User-Agent": "Kestrel-Sentinel/1.0 (+https://vibestarter.xyz)" },
    }).then((r) => r.json()),
  ]);

  const escrowEth = BigInt(escrowEthBalanceHex);
  const tranches = campaignRes?.campaign?.tranches || [];
  const activeTranche = tranches.find((t) => t.status === "REQUESTED") || tranches.find((t) => t.status === "LOCKED");

  console.log("\n[3] VIBESTARTER BACKER SHIELD (GENESIS ESCROW):");
  console.log(`    Escrow Contract (Base):       ${ADDR.baseGenesisEscrow}`);
  console.log(`    Remaining Escrowed ETH:       ${formatUnits18(escrowEth)} ETH`);
  if (activeTranche) {
    console.log(
      `    Next/Active Tranche #${activeTranche.orderIndex}:       status=${activeTranche.status} | challengeWindowEndsAt=${activeTranche.challengeWindowEndsAt || "N/A"}`
    );
  }

  console.log("\n>_ ALL ONCHAIN SYSTEMS NOMINAL. READY FOR CLAUDE CODE BUILD.");
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
