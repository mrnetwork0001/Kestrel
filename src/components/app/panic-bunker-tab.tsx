"use client";

import type { ScanResult } from "@/lib/engine/types";
import { PanicBunker } from "./panic-bunker";

/**
 * Workspace Panic Bunker: rescues the scanned wallet (or any contract account such as a Safe / smart wallet) read-only
 * without a wallet. Token / pool / escrow targets are not wallets, so the bunker explains that, highlights the scanned
 * token(s) for the connected wallet, and offers the 1-click live public-wallet preview.
 */
export function PanicBunkerTab({ target, chainId, scan }: { target?: string; chainId?: number; scan?: ScanResult | null }) {
  const matches = !!scan && !!target && scan.target.address.toLowerCase() === target.toLowerCase() && scan.target.chainId === chainId;
  const kind = matches ? scan!.target.kind : null;
  const isAccount = kind === "wallet" || kind === "contract";
  const focus = !matches ? [] : (kind === "pool" ? [scan!.pool?.token0.address, scan!.pool?.token1.address] : [scan!.token?.address]).filter((x): x is string => !!x);
  let context: string | null = null;
  if (chainId === 4663) context = "Panic Bunker executes on Base (8453). The scanned target is on Robinhood Chain, so it is not previewed here.";
  else if (matches && !isAccount) {
    const what = kind === "pool" ? "a pool" : kind === "escrow" ? "a Vibestarter escrow" : "a token";
    context = `The scanned target (${scan!.target.label || target}) is ${what}, not a wallet. Connect the wallet exposed to it and its approvals on ${focus.length ? "that asset are highlighted" : "Base are listed"}, or preview a live public wallet below.`;
  }
  return <PanicBunker previewAddress={isAccount && chainId === 8453 ? target : null} previewChainId={chainId ?? 8453} focusTokens={focus} context={context} />;
}
