import type { Address } from "viem";

/**
 * Vibestarter address book for Base (8453) and Robinhood Chain (4663), verified live on 2026-11-07
 * (eth_getCode / eth_call / Sourcify exact-match sources; see research spec §5.1).
 *
 * IMPORTANT: the same deployer nonces were used on both chains, so several addresses collide across
 * chains with DIFFERENT roles (e.g. 0x66b7… is VibesRegistry on Base but the eligibility registry on
 * Robinhood Chain). Every label / ABI lookup must be keyed by `chainId:address` — use `vibestarterLabel()`.
 */
export const VIBESTARTER = {
  8453: {
    router: "0x783a7DB4113DC35A87dA43319af3cA7E6428f4BC" as Address,
    routerDeployBlock: 47_169_851n,
    routerExtension: "0x2bF527A8e8EE070D7b68d92728e171338AA95602" as Address,
    /** old factory first (Genesis), then the current factory. */
    factories: [
      { address: "0xce977a23be9e40cbfbb418179eab8704b88edd18" as Address, label: "VibesTranchEscrowFactory (v1, Genesis)" },
      { address: "0x36C7e2d87F4E2d33b70304EbaA81eE88CB04Bf86" as Address, label: "VibesTranchEscrowFactory (v2)" },
    ],
    /** V2 first: Genesis' own escrow.lpLocker() still points at the empty V1 locker, but its lock lives in V2. */
    lpLockers: [
      { address: "0x728D954fC216396B2b5a272D12562E8A557E35b2" as Address, version: "v2" as const },
      { address: "0x2949f0F0F3A9317a6dfaf68Ea80F00057A699F8c" as Address, version: "v1" as const },
    ],
    feeClaimerImpl: "0x3697f4eBa88bF657569553Ec6EC3178c74D10109" as Address,
    eligibilityRegistry: "0x7862D45068fad3dA9746DFc88cbAEa42380AAe2e" as Address,
    vibesRegistry: "0x66b74176F53d3081a87F75e10aD6cF554174Aef9" as Address,
    tokenFactory: "0x3671DBD5CFaF1D0D5c15a18b65F2CC7AcC7faE29" as Address,
    stakerRewards: "0x8a6d46cB0f56DFCd0CfBBfb985e27fC3398F898a" as Address,
    escrowImpls: {
      "0xcbe7e9e13576838eb4b55d0793fd1cffc1dea43d": "v2",
      "0xba886d9fe4b3d1a5cd276de9f379e8449abc202a": "v1",
    } as Record<string, "v1" | "v2">,
    admin: "0x56E3b5B48e2628040870b47F233821ca3Ef4A564" as Address,
    platformSafe: "0x3CFDbf58Ed6866cD45Fb8B273EBA32a6259fFee0" as Address,
    backendSigner: "0x51e8932F7b1c81d802bF1409f3762373aC8EEBf7" as Address,
  },
  4663: {
    router: "0x27E2841AA1F20c4838A9FeDE650F6eA5561264eC" as Address,
    routerDeployBlock: null,
    routerExtension: "0x2f176b0bcAA34f153BDA9C70C34736A427eAa0a7" as Address,
    factories: [{ address: "0xFE004c6451c7C4799f53e86bA33208C2C07ea607" as Address, label: "VibesTranchEscrowFactory (Robinhood)" }],
    lpLockers: [{ address: "0x2bF527A8e8EE070D7b68d92728e171338AA95602" as Address, version: "v2" as const }],
    feeClaimerImpl: null,
    eligibilityRegistry: "0x66b74176F53d3081a87F75e10aD6cF554174Aef9" as Address,
    vibesRegistry: "0x3697f4eBa88bF657569553Ec6EC3178c74D10109" as Address,
    tokenFactory: "0x2949f0F0F3A9317a6dfaf68Ea80F00057A699F8c" as Address,
    stakerRewards: "0x196eEeb68c89d7519Ff7A5d6EE1231bB873307FD" as Address,
    escrowImpls: { "0xd579f67a951011b04f99baed3b315222f7099d44": "v2" } as Record<string, "v1" | "v2">,
    admin: null,
    platformSafe: null,
    backendSigner: null,
  },
} as const;

export type VibestarterChainId = keyof typeof VIBESTARTER;

/** Vibestarter's deep link for a raise page (launch tx hash, or "vibes" for Genesis). */
export function vibestarterRaiseUrl(launchTxOrSlug: string | null | undefined): string | null {
  if (!launchTxOrSlug) return null;
  return `https://app.vibestarter.xyz/raises/${launchTxOrSlug}`;
}

const k = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

/** Collision-free label map keyed by `chainId:address` (lower-cased). */
export const VIBESTARTER_LABELS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const b = VIBESTARTER[8453];
  const r = VIBESTARTER[4663];
  out[k(8453, b.router)] = "Vibestarter Launch Router V2";
  out[k(8453, b.routerExtension)] = "Vibestarter Router Extension";
  for (const f of b.factories) out[k(8453, f.address)] = f.label;
  out[k(8453, b.lpLockers[0].address)] = "VibesLPLockerV2";
  out[k(8453, b.lpLockers[1].address)] = "VibesLPLocker (v1)";
  out[k(8453, b.feeClaimerImpl)] = "VibesLPFeeClaimer (impl)";
  out[k(8453, b.eligibilityRegistry)] = "Vibes Eligibility Registry";
  out[k(8453, b.vibesRegistry)] = "VibesRegistry (Origin Capsule)";
  out[k(8453, b.tokenFactory)] = "VibesTokenFactory";
  out[k(8453, b.stakerRewards)] = "Vibes Staker Rewards";
  out[k(8453, b.admin)] = "Vibestarter Escrow Admin (EOA)";
  out[k(8453, b.platformSafe)] = "Vibestarter Platform Safe (2-of-3)";
  out[k(8453, b.backendSigner)] = "Vibestarter Backend Signer";
  out[k(8453, "0xcBe7e9E13576838eb4B55d0793Fd1CFFC1Dea43d")] = "VibesTranchEscrow impl (v2)";
  out[k(8453, "0xbA886D9FE4B3d1A5cD276De9f379E8449abC202A")] = "VibesTranchEscrow impl (v1)";
  out[k(8453, "0x2f176b0bcAA34f153BDA9C70C34736A427eAa0a7")] = "Vibes Community Rewards Factory";
  out[k(4663, r.router)] = "Vibestarter Launch Router (Robinhood)";
  out[k(4663, r.routerExtension)] = "Vibestarter Router Extension (Robinhood)";
  for (const f of r.factories) out[k(4663, f.address)] = f.label;
  out[k(4663, r.lpLockers[0].address)] = "Vibes LP Locker (Robinhood)";
  out[k(4663, r.eligibilityRegistry)] = "Vibes Eligibility Registry (Robinhood)";
  out[k(4663, r.vibesRegistry)] = "VibesRegistry (Robinhood)";
  out[k(4663, r.tokenFactory)] = "VibesTokenFactory (Robinhood)";
  out[k(4663, r.stakerRewards)] = "Vibes Staker Rewards (Robinhood)";
  out[k(4663, "0xd579F67a951011b04f99bAED3B315222F7099D44")] = "VibesTranchEscrow impl (Robinhood v2)";
  return out;
})();

/** Label for a Vibestarter infrastructure address on a specific chain (null if unknown). */
export function vibestarterLabel(chainId: number, address: string | null | undefined): string | null {
  if (!address) return null;
  return VIBESTARTER_LABELS[k(chainId, address)] ?? null;
}

export function vibestarterConfig(chainId: number) {
  return chainId === 4663 ? VIBESTARTER[4663] : VIBESTARTER[8453];
}
