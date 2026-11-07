import type { Metadata } from "next";
import { cache, Suspense } from "react";
import type { Address } from "viem";
import { PanicBunker } from "@/components/app/panic-bunker";
import { TargetMasthead } from "@/components/app/shell/target-masthead";
import { InkLink, Kicker, SkeletonRows, Wrap } from "@/components/editorial";
import { DEMO_RESCUE_WALLET } from "@/config/demo";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { cached } from "@/lib/cache";
import { parseAddress, parseChainId } from "@/lib/engine/chain-utils";
import { cachedScan } from "@/lib/engine/scan";
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

/**
 * Same key as /api/scan and /app, so a pager click, the workspace and the API share one cached scan. cachedScan never
 * stores a degraded scan; a degraded result is still rendered here, with the failed reads named in the masthead.
 */
const scanOnce = cache((chainId: ChainId, target: Address): Promise<{ result: ScanResult; degraded: string[] } | null> =>
  cachedScan(chainId, target, { useLlm: false }).catch(() => null)
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
  const rawTarget = str(sp.target);
  const target = parseAddress(rawTarget);
  const chainId = parseChainId(str(sp.chain), 8453);
  const revoke = str(sp.revoke);
  const revokeOnly = revoke && /^0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]{40}$/.test(revoke) ? revoke : null;
  const fromPager = str(sp.from) === "pager";

  return (
    <div className="pb-16 max-[601px]:pb-10">
      <Wrap className="pt-10 pb-8 max-[601px]:pt-6 max-[601px]:pb-6">
        <p className="t-kicker text-crit">[ LIVE // PANIC BUNKER ]</p>
        <h1 className="mt-4 max-w-[22ch] font-serif text-[clamp(32px,3.6vw,52px)] leading-[1.04] tracking-[-0.01em] text-ink [text-wrap:balance]">One signature. Every risky approval gone.</h1>
        <p className="mt-4 max-w-[68ch] text-[16px] leading-relaxed text-ink-2">
          Kestrel builds a rescue bundle: <span className="mono text-[14px] text-ink">approve(spender, 0)</span> for each ERC-20 allowance, a single <span className="mono text-[14px] text-ink">Permit2.lockdown()</span> for Permit2 sub-allowances, and optional Aerodrome unwinds to USDC. It simulates every call with{" "}
          <span className="mono text-[14px] text-ink">simulateContract</span> before you sign. Smart Wallets execute it atomically via <span className="mono text-[14px] text-ink">wallet_sendCalls</span>; standard EOAs get a guided sequential flow.
        </p>
        {fromPager && (
          <p className="mt-6 border-l-2 border-warn pl-4 mono text-[13px] text-warn" role="status">
            Opened from a Night-Shift Pager alert.
          </p>
        )}
      </Wrap>

      {!chainId ? (
        <Wrap className="pt-2">
          <div className="border-t border-hair-strong pt-6">
            <Kicker tone="warn">Unsupported chain · {str(sp.chain)}</Kicker>
            <p className="mt-4 max-w-[40ch] font-serif text-[22px] leading-snug text-ink">Kestrel reads Base 8453 or Robinhood Chain 4663.</p>
            <p className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
              {target && <InkLink href={`/rescue?target=${target}&chain=8453`}>Open this address on Base</InkLink>}
              <InkLink href="/rescue">Back to the Panic Bunker</InkLink>
            </p>
          </div>
        </Wrap>
      ) : target ? (
        <>
          <Suspense fallback={<TargetMasthead scan={null} target={target} chainId={chainId} loading share={false} />}>
            <TargetSummary chainId={chainId} target={target} />
          </Suspense>
          <Wrap className="pt-8">
            <p className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-[14px] text-ink-2">
              <InkLink href={`/app?target=${target}&chain=${chainId}&tab=briefing`}>Full briefing for this target</InkLink>
              <InkLink href={`/app?target=${target}&chain=${chainId}&tab=chaos`}>Simulate the exit</InkLink>
            </p>
            <Suspense fallback={<SkeletonRows rows={4} heights={[56, 48, 48, 48]} caption="Reading the deep-linked target live from Base" />}>
              <TargetBunker chainId={chainId} target={target} revokeOnly={revokeOnly} />
            </Suspense>
          </Wrap>
        </>
      ) : (
        <Wrap className="pt-2">
          <form action="/rescue" method="get" className="panel flex min-h-[48px] items-stretch max-[601px]:flex-col">
            <label htmlFor="rescue-target" className="flex shrink-0 items-center gap-2 border-r border-hair px-4 mono text-[13px] text-phosphor max-[601px]:border-r-0 max-[601px]:border-b max-[601px]:py-2">
              <span aria-hidden="true">&gt;_</span>
              <span className="text-ink-meta">wallet on Base</span>
            </label>
            <input
              id="rescue-target"
              name="target"
              required
              pattern="^0x[0-9a-fA-F]{40}$"
              placeholder="Paste any 0x wallet address"
              defaultValue={rawTarget ?? ""}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-4 py-3 mono text-[14px] text-ink placeholder:text-ink-meta focus:outline-none max-[901px]:text-[16px]"
            />
            <input type="hidden" name="chain" value="8453" />
            <button type="submit" className="btn-outline press shrink-0 rounded-none border-0 border-l border-hair px-5 max-[601px]:min-h-[48px] max-[601px]:border-l-0 max-[601px]:border-t">
              READ APPROVALS
            </button>
          </form>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-2">
            {rawTarget && !target && <span className="mono text-[13px] text-crit">Not a valid 0x address.</span>}
            <span className="text-ink-meta">No wallet handy?</span>
            <InkLink href={`/rescue?target=${DEMO_RESCUE_WALLET.address}&chain=8453`}>Preview the {DEMO_RESCUE_WALLET.label} live</InkLink>
          </p>
          <div className="mt-8">
            <PanicBunker />
          </div>
        </Wrap>
      )}
    </div>
  );
}

async function TargetSummary({ chainId, target }: { chainId: ChainId; target: Address }) {
  const r = await scanOnce(chainId, target);
  const notice =
    chainId !== 8453 ? (
      <p className="max-w-[34ch] text-[13px] leading-relaxed text-warn min-[901px]:text-right">Panic Bunker executes on Base; Robinhood Chain targets are shown read-only.</p>
    ) : undefined;
  return (
    <TargetMasthead
      scan={r?.result ?? null}
      target={target}
      chainId={chainId}
      loading={false}
      error={r ? null : "Live scan unavailable right now. The rescue below still reads allowances directly from Base."}
      degraded={r?.degraded ?? []}
      notice={notice}
      share={false}
    />
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
  const scan = (await scanOnce(8453, target))?.result ?? null;
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
