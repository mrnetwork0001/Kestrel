import type { Address } from "viem";

/**
 * Public, non-personal Base wallet used for the 1-click "preview a live rescue" path (no wallet connect).
 *
 * Send's treasury Safe multisig. Basescan public name tag: "Send: 4/7 Multisig - Treasury".
 * Verified live on Base 2026-11-07: Safe getThreshold/getOwners answer (3-of-5), and against Kestrel's Base
 * spender list it holds several UNLIMITED allowances (WETH → Permit2, WETH/AERO → CoW GPv2VaultRelayer,
 * USDC → Uniswap v3 Position Manager) plus a USDC balance. Kestrel only reads it; nobody but its owners can sign.
 * The approvals shown in the UI are always re-read live, so if the Safe revokes, the preview says so.
 */
export const DEMO_RESCUE_WALLET = {
  address: "0x05CEa6C36f3a44944A4F4bA39B1820677AcB97EE" as Address,
  chainId: 8453 as const,
  label: "Send treasury Safe",
  source: "Basescan public name tag “Send: 4/7 Multisig - Treasury”",
} as const;

export function isDemoWallet(address: string | null | undefined): boolean {
  return !!address && address.toLowerCase() === DEMO_RESCUE_WALLET.address.toLowerCase();
}
