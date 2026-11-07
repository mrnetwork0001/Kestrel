import type { CSSProperties, ReactNode } from "react";
import { Suspense } from "react";
import { CONTRACTS } from "@/config/contracts";
import { Countdown } from "@/components/countdown";
import { ProportionBars } from "@/components/data/proportion-bars";
import { TrancheRuler } from "@/components/data/tranche-ruler";
import { InkLink, Kicker, Rule, SkeletonRows, Wrap } from "@/components/editorial";
import { Led, rv, Settle, SplitWords } from "@/components/motion";
import { AddrLink, cx, TxLink } from "@/components/ui";
import { explorerBlock, fmtBps, fmtCompact, fmtUnits } from "@/lib/format";
import type { EscrowReport, ParityReport } from "@/lib/engine/types";
import { getEscrow, getParity, parityVerdict } from "./data";

/*
 * S1 · The Overnight Ledger: a full-bleed band directly under the hero fold.
 * Left = bridge parity (the lead story, data-driven headline); right = Genesis escrow Backer Shield (the only countdown on '/').
 * Every figure is a live read from the shared cached getters in ./data (no new RPC reads). A null read renders one
 * honest warn sentence, never an empty box and never 0.
 */
export function LedgerSection() {
  return (
    <Suspense
      fallback={
        <Wrap band className="py-24 max-[601px]:py-16">
          <p className="t-kicker text-ink-meta">The overnight ledger</p>
          <div className="mt-8 grid gap-10 min-[901px]:grid-cols-12 min-[901px]:gap-6">
            <SkeletonRows className="min-[901px]:col-span-7" heights={[96, 120, 64, 64, 48, 48]} />
            <SkeletonRows className="min-[901px]:col-span-5" heights={[64, 72, 56, 64, 56]} caption="Reading the Genesis escrow on Base" />
          </div>
        </Wrap>
      }
    >
      <Ledger />
    </Suspense>
  );
}

async function Ledger() {
  const [parity, escrow] = await Promise.all([getParity(), getEscrow()]);
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <Wrap band className="py-24 max-[601px]:py-16">
      <Kicker tone="meta" led={<Led tone="phosphor" />}>
        The overnight ledger
        {parity && (
          <>
            {" · read at "}
            <BlockLink chainId={8453} n={parity.base.number} name="Base" />
            {" · "}
            <BlockLink chainId={4663} n={parity.robinhood.number} name="Robinhood" />
          </>
        )}
      </Kicker>

      <div className="mt-8 grid gap-12 min-[901px]:grid-cols-[minmax(0,7fr)_1px_minmax(0,5fr)] min-[901px]:gap-10 max-[600px]:mt-6">
        <div className="min-w-0">{parity ? <ParityStory p={parity} /> : <Unavailable>Parity read unavailable at this block; open the app for a fresh read.</Unavailable>}</div>
        <Rule vertical className="max-[900px]:hidden" d={120} />
        <Rule className="min-[901px]:hidden" />
        <div className="min-w-0">{escrow ? <ShieldStory e={escrow} nowSec={nowSec} /> : <Unavailable>Escrow read unavailable at this block; open the app for a fresh read.</Unavailable>}</div>
      </div>
    </Wrap>
  );
}

function BlockLink({ chainId, n, name }: { chainId: number; n: string; name: string }) {
  return (
    <a href={explorerBlock(chainId, n)} target="_blank" rel="noreferrer" className="tnum text-ink-2 underline decoration-white/15 underline-offset-[3px] hover:text-ink hover:decoration-white/50">
      {name} #{n}
    </a>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="mono text-[13px] text-warn">{children}</p>;
}

/* ───────────── LEFT: bridge parity ───────────── */

function ParityStory({ p }: { p: ParityReport }) {
  const pv = parityVerdict(p);
  const zero = BigInt(p.delta) === 0n;
  const exact = pv.label === "EXACT";
  const tone = pv.tone === "crit" ? "text-crit" : exact ? "text-phosphor" : "text-warn";
  const venue = p.cheaperVenue === "base" ? "Base Aerodrome" : p.cheaperVenue === "robinhood" ? "Robinhood Uniswap v3" : null;
  return (
    <article>
      {zero ? (
        <SplitWords parts={["Not one wei apart."]} className="t-h2" d={140} />
      ) : (
        <h2 className="t-h2" data-rv="words" suppressHydrationWarning style={{ "--d": "140ms" } as CSSProperties}>
          <span className="w">
            <span className="text-warn" style={{ "--i": 0 } as CSSProperties}>
              {fmtUnits(p.delta, 18)}
            </span>
          </span>{" "}
          <span className="w">
            <span style={{ "--i": 1 } as CSSProperties}>VIBES</span>
          </span>{" "}
          <span className="w">
            <span style={{ "--i": 2 } as CSSProperties}>apart.</span>
          </span>
        </h2>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-2">
        <Settle value={zero ? "Δ 0" : `Δ ${fmtCompact(p.delta, 18)}`} className={cx("t-display-xl", tone)} d={380} />
        <p className="mono pb-3 text-[12px] tracking-[0.14em] max-[600px]:pb-1" {...rv(4, "up", 300)}>
          <span className={tone}>{pv.label}</span>
          <span className="text-ink-meta"> · {pv.sub}</span>
        </p>
      </div>

      <p className="t-stand mt-6 max-w-[34ch]" {...rv(5, "up", 300)}>
        {fmtCompact(p.lockedOnBase, 18)} $VIBES locked on Base. {fmtCompact(p.rhCirculating, 18)} circulating on Robinhood Chain.
      </p>

      <div className="mt-8 max-w-xl">
        <ProportionBars
          a={{ value: p.lockedOnBase, tone: "base", label: <AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} label="Locked · Base OFT adapter" className="text-[13px]" /> }}
          b={{ value: p.rhCirculating, tone: "rh", label: <AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} label="Circulating · Robinhood (supply − reserve)" className="text-[13px]" /> }}
        />
      </div>

      <p className="mono mt-6 text-[13px] text-ink-2 [overflow-wrap:anywhere]" {...rv(6, "up", 380)}>
        BaseAdapter.balanceOf == RH.totalSupply − RHReserve.balanceOf
      </p>
      {p.spreadBps != null && (
        <p className="t-body mt-3" {...rv(7, "up", 380)}>
          <span className="tnum text-ink">Spread {fmtBps(p.spreadBps)}</span>
          {venue && <> · $VIBES cheaper on {venue}</>}
          {p.netEdgeBps != null && (
            <>
              {" · net edge "}
              <span className={cx("tnum", p.netEdgeBps > 0 ? "text-phosphor" : "text-ink")}>{p.netEdgeBps} bps</span> after fees
            </>
          )}
        </p>
      )}
      <div className="mt-5" {...rv(8, "up", 380)}>
        <InkLink href="/app?tab=parity" className="text-[15px]">
          Open Parity Radar
        </InkLink>
      </div>
    </article>
  );
}

/* ───────────── RIGHT: Backer Shield ───────────── */

function ShieldStory({ e, nowSec }: { e: EscrowReport; nowSec: number }) {
  const open = e.tranches.find((t) => t.status === "CHALLENGE_WINDOW" && t.windowEndsAt > nowSec) ?? null;
  const unlock = !open ? nextUnlock(e, nowSec) : null;
  return (
    <article>
      <Kicker tone="base" d={80}>
        Genesis $VIBES escrow · Base
      </Kicker>
      <div className="mt-5">
        <Settle value={`${fmtUnits(e.escrowBalance, 18, 2)} ETH`} className="t-data-l text-ink" d={380} />
      </div>
      <p className="t-stand mt-3 max-w-[26ch] text-[22px]" {...rv(2, "up", 300)}>
        still escrowed of {fmtUnits(e.totalRaised, 18, 2)} ETH raised{e.contributorCount != null ? ` from ${e.contributorCount.toLocaleString("en-US")} backers` : ""}.
      </p>

      <div className="mt-8">
        <TrancheRuler tranches={e.tranches} size="m" />
      </div>

      {open ? (
        <p className="mono mt-6 flex flex-wrap items-center gap-2 text-[14px] text-warn" {...rv(3, "up", 380)}>
          <Led tone="warn" />
          <span>72h challenge window closes in</span>
          <Countdown to={open.windowEndsAt} initialNow={nowSec} className="tnum" />
        </p>
      ) : unlock ? (
        <p className="mono mt-6 text-[14px] text-ink-2" {...rv(3, "up", 380)}>
          Month {unlock.k} unlocks in <Countdown to={unlock.at} initialNow={nowSec} className="tnum text-ink" />
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hair pt-4 mono text-[13px]" {...rv(4, "up", 380)}>
        <span className="text-ink-meta">Permanent LP</span>
        <span className="text-ink-3">·</span>
        <span className={e.lpCreated ? "text-phosphor" : "text-warn"}>{e.lpCreated ? "LOCKED" : "NOT CREATED"}</span>
        {e.lpLockTxHash && (
          <>
            <span className="text-ink-3">·</span>
            <TxLink chainId={8453} hash={e.lpLockTxHash} label="lock tx" />
          </>
        )}
        <span className="ml-auto">
          <AddrLink chainId={8453} address={e.address} className="text-[13px]" />
        </span>
      </div>
      <div className="mt-5" {...rv(5, "up", 380)}>
        <InkLink href="/ecosystem" className="text-[15px]">
          All escrows on Base + Robinhood
        </InkLink>
      </div>
    </article>
  );
}

/** The next scheduled tranche unlock (same source the Backer Shield tab counts down to), only if it is in the future. */
function nextUnlock(e: EscrowReport, nowSec: number): { k: number; at: number } | null {
  const ev = e.nextEvent;
  if (ev?.kind === "tranche-unlock" && ev.at != null && ev.at > nowSec && ev.tranche != null) return { k: ev.tranche, at: ev.at };
  const t = e.tranches[e.nextTranche];
  if (t && t.index >= 1 && t.unlockTime > nowSec && t.status !== "HALTED") return { k: t.index, at: t.unlockTime };
  return null;
}
