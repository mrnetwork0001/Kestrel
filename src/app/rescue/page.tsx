import type { Metadata } from "next";
import { PanicBunker } from "@/components/app/panic-bunker";
import { AddrLink, BandBadge, ChainBadge, SectionLabel } from "@/components/ui";
import { normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { scanTarget } from "@/lib/engine/scan";

export const metadata: Metadata = {
  title: "Panic Bunker — Atomic EIP-5792 Rescue",
  description: "Revoke every risky ERC-20 and Permit2 approval and unwind exposed tokens to USDC on Base in one EIP-5792 wallet_sendCalls signature, with simulateContract checks before you sign.",
};

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function RescuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const target = parseAddress(typeof sp.target === "string" ? sp.target : undefined);
  const chainId = normalizeChainId(typeof sp.chain === "string" ? sp.chain : 8453);
  const scan = target ? await scanTarget(chainId, target, { useLlm: false }).catch(() => null) : null;

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-10">
      <SectionLabel n="05">Panic Bunker · EIP-5792 atomic rescue</SectionLabel>
      <h1 className="mt-4 font-serif text-[44px] leading-[1.05] text-ink">One signature. Every risky approval gone.</h1>
      <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-ink-2">
        Kestrel builds a rescue bundle — <span className="mono text-ink">approve(spender, 0)</span> for each ERC-20 allowance, a single{" "}
        <span className="mono text-ink">Permit2.lockdown()</span> for Permit2 sub-allowances, and optional Aerodrome unwinds to USDC — then simulates every call
        with <span className="mono text-ink">simulateContract</span> before you sign. Smart Wallets execute it atomically via{" "}
        <span className="mono text-ink">wallet_sendCalls</span>; standard EOAs get a guided sequential flow.
      </p>
      {target && (
        <div className="mt-6 flex flex-wrap items-center gap-3 border hairline bg-surface px-4 py-3 text-[13px]">
          <span className="label">Deep-linked target</span>
          <ChainBadge chainId={chainId} />
          <AddrLink chainId={chainId} address={target} n={6} />
          {scan && (
            <>
              <BandBadge band={scan.band} />
              <span className="text-ink-2">{scan.score}/100 · {scan.target.label}</span>
            </>
          )}
          {chainId !== 8453 && <span className="text-warn">Panic Bunker executes on Base; Robinhood Chain targets are shown read-only.</span>}
        </div>
      )}
      <div className="mt-8">
        <PanicBunker previewAddress={scan?.target.kind === "wallet" ? target : null} previewChainId={chainId} />
      </div>
    </div>
  );
}
