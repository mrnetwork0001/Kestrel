import type { Metadata } from "next";
import Link from "next/link";
import { cache, type ReactNode, Suspense } from "react";
import type { Address } from "viem";
import { PanicBunker } from "@/components/app/panic-bunker";
import { AddrLink, BandBadge, ChainBadge, SectionLabel } from "@/components/ui";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { cached } from "@/lib/cache";
import { normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";
import type { ChainId, ScanResult } from "@/lib/engine/types";
import { readLiveExposure } from "@/lib/rescue/live-approvals";
import { basePublicClient } from "@/lib/rpc";

export const metadata: Metadata = {
  title: "Panic Bunker — Atomic EIP-5792 Rescue",
  description: "Revoke every risky ERC-20 and Permit2 approval and unwind exposed tokens to USDC on Base in one EIP-5792 wallet_sendCalls signature, with simulateContract checks before you sign.",
  alternates: { canonical: "/rescue" },
  openGraph: {
    title: "Kestrel Panic Bunker — one signature, every risky approval gone",
    description: "Live allowance + Permit2 read, exact rescue calldata, simulation before signing, EIP-5792 atomic batch or guided sequential fallback.",
  },
};

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SP = Promise<Record<string, string | string[] | undefined>>;

/** Same key as /api/scan and /app, so a pager click, the workspace and the API share one cached scan. */
const scanOnce = cache((chainId: ChainId, target: Address): Promise<ScanResult | null> =>
  cached(`scan:${chainId}:${target.toLowerCase()}:0:`, 30, () => scanTarget(chainId, target, { useLlm: false })).catch(() => null)
);

const liveOnce = cache((target: Address) =>
  cached(`rescue:live:${target.toLowerCase()}`, 15, () => readLiveExposure(basePublicClient, target)).catch(() => null)
);

/** EOAs and EIP-7702 accounts are wallets without needing the full scan. */
const isPlainAccount = cache(async (target: Address) => {
  const code = await basePublicClient.getCode({ address: target }).catch(() => undefined);
  if (code === undefined) return null;
  const insp = inspectRawBytecode(code);
  return !insp.isContract || !!insp.eip7702Delegate;
});

function str(v: string | string[] | undefined) {
  return typeof v === "string" ? v : undefined;
}

export default async function RescuePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const target = parseAddress(str(sp.target));
  const chainId = normalizeChainId(str(sp.chain) ?? 8453);
  const revoke = str(sp.revoke);
  const revokeOnly = revoke && /^0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]{40}$/.test(revoke) ? revoke : null;
  const fromPager = str(sp.from) === "pager";

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-10 max-[600px]:px-3 max-[600px]:pt-6">
      <SectionLabel n="05">Panic Bunker · EIP-5792 atomic rescue</SectionLabel>
      <h1 className="mt-4 font-serif text-[36px] leading-[1.05] text-ink sm:text-[44px] max-[600px]:text-[32px]">One signature. Every risky approval gone.</h1>
      <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-ink-2">
        Kestrel builds a rescue bundle — <span className="mono text-ink">approve(spender, 0)</span> for each ERC-20 allowance, a single{" "}
        <span className="mono text-ink">Permit2.lockdown()</span> for Permit2 sub-allowances, and optional Aerodrome unwinds to USDC — then simulates every call
        with <span className="mono text-ink">simulateContract</span> before you sign. Smart Wallets execute it atomically via{" "}
        <span className="mono text-ink">wallet_sendCalls</span>; standard EOAs get a guided sequential flow.
      </p>
      {fromPager && <p className="mt-6 border border-warn/40 bg-warn/[0.06] px-4 py-2.5 mono text-[12px] text-warn">Opened from a Night-Shift Pager alert.</p>}
      {target ? (
        <>
          <Suspense fallback={<TargetBar chainId={chainId} target={target} />}>
            <TargetSummary chainId={chainId} target={target} />
          </Suspense>
          <div className="mt-8">
            <Suspense fallback={<p className="mono text-[12px] text-ink-3 cursor-blink">Reading the deep-linked target live from Base</p>}>
              <TargetBunker chainId={chainId} target={target} revokeOnly={revokeOnly} />
            </Suspense>
          </div>
        </>
      ) : (
        <div className="mt-8">
          <PanicBunker />
        </div>
      )}
    </div>
  );
}

function TargetBar({ chainId, target, children }: { chainId: number; target: string; children?: ReactNode }) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border hairline bg-surface px-4 py-3 text-[13px] max-[600px]:gap-x-2 max-[600px]:gap-y-1.5 max-[600px]:px-3">
      <span className="label">Deep-linked target</span>
      <ChainBadge chainId={chainId} />
      <AddrLink chainId={chainId} address={target} n={6} />
      {children}
    </div>
  );
}

async function TargetSummary({ chainId, target }: { chainId: ChainId; target: Address }) {
  const scan = await scanOnce(chainId, target);
  return (
    <TargetBar chainId={chainId} target={target}>
      {scan ? (
        <>
          <BandBadge band={scan.band} />
          <span className="text-ink-2">
            {scan.score}/100 · {scan.target.label} · block #{BigInt(scan.block.number).toLocaleString("en-US")}
          </span>
          <Link href={`/app?target=${target}&chain=${chainId}&tab=${scan.target.kind === "pool" || scan.target.kind === "token" ? "chaos" : "briefing"}`} className="mono text-[11px] text-phosphor hover:underline">
            {scan.target.kind === "pool" || scan.target.kind === "token" ? "simulate exit →" : "full briefing →"}
          </Link>
        </>
      ) : (
        <span className="mono text-[11px] text-ink-3">live scan unavailable right now</span>
      )}
      {chainId !== 8453 && <span className="text-warn">Panic Bunker executes on Base; Robinhood Chain targets are shown read-only.</span>}
    </TargetBar>
  );
}

async function TargetBunker({ chainId, target, revokeOnly }: { chainId: ChainId; target: Address; revokeOnly: string | null }) {
  if (chainId !== 8453) {
    return <PanicBunker context="This target is on Robinhood Chain (4663). The Panic Bunker signs on Base, so connect a Base wallet or preview a live one below." />;
  }
  // Fast path: EOAs / EIP-7702 accounts skip the full scan and go straight to the live allowance read.
  const plain = await isPlainAccount(target);
  if (plain) {
    const live = await liveOnce(target);
    return <PanicBunker previewAddress={target} previewChainId={8453} initialLive={live} revokeOnly={revokeOnly} />;
  }
  const scan = await scanOnce(8453, target);
  const kind = scan?.target.kind ?? "contract";
  if (kind === "wallet" || kind === "contract") {
    // Contract accounts (Safe multisigs, smart wallets) are rescued too: their allowances are read the same way.
    const live = await liveOnce(target);
    return <PanicBunker previewAddress={target} previewChainId={8453} initialLive={live} revokeOnly={revokeOnly} />;
  }
  const focusMeta = kind === "pool" ? [scan?.pool?.token0, scan?.pool?.token1] : [scan?.token];
  const focus = focusMeta.map((t) => t?.address).filter((x): x is string => !!x);
  const symbols = [...new Set(focusMeta.map((t) => t?.symbol).filter(Boolean))].join(" / ");
  const what = kind === "pool" ? "a liquidity pool" : kind === "escrow" ? "a Vibestarter escrow" : "a token";
  const context = `This alert points at ${scan?.target.label || "the target"}, ${what}, not a wallet. Connect the wallet exposed to it: its approvals${symbols ? ` on ${symbols}` : ""} are highlighted and VIBES / WETH balances can be unwound to USDC. Or preview a live public wallet's rescue below.`;
  return <PanicBunker focusTokens={focus} context={context} />;
}
