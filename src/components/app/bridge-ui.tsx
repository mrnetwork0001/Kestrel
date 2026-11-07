"use client";

import type { CSSProperties, ReactNode } from "react";
import { AddrLink, ChainBadge, cx, Panel } from "@/components/ui";
import { chainShort, fmtCompact, fmtDuration, fmtUnits, fmtUtc } from "@/lib/format";
import type { EthUsdQuote, OftBridgeReport, OftGovernance, OftLane, ParityReport, ParityVerdict } from "@/lib/engine/types";

/** USD value of a raw wei amount at the live onchain ETH/USD (Uniswap v3 WETH/USDC slot0). Null when no live quote. */
export function usdOfWei(wei: bigint | string, ethUsd: EthUsdQuote | null | undefined): string | null {
  if (!ethUsd) return null;
  const w = typeof wei === "string" ? BigInt(wei) : wei;
  const neg = w < 0n;
  const usdc = ((neg ? -w : w) * BigInt(ethUsd.usdcPerWeth)) / 10n ** 18n;
  return `${neg ? "−" : ""}$${fmtUnits(usdc, 6, 2)}`;
}

/** "0.000117 Ξ · $0.26" — USD part only when a live ETH/USD quote exists. */
export function ethWithUsd(wei: bigint | string, ethUsd: EthUsdQuote | null | undefined, maxFrac = 6): string {
  const usd = usdOfWei(wei, ethUsd);
  return `${fmtUnits(wei, 18, maxFrac)} Ξ${usd ? ` · ${usd}` : ""}`;
}

const VERDICT_STYLE: Record<ParityVerdict, string> = {
  EXACT: "text-phosphor",
  IN_FLIGHT: "text-warn",
  OVER_BACKED: "text-warn",
  UNBACKED: "text-crit",
};

export const VERDICT_TEXT: Record<ParityVerdict, string> = {
  EXACT: "Locked on Base equals circulating on Robinhood to the last wei.",
  IN_FLIGHT: "LayerZero packets are sent but not yet delivered, so locked temporarily exceeds circulating. This closes on delivery.",
  OVER_BACKED: "More VIBES is locked than circulates, with no packet in flight. Holders are over-collateralised.",
  UNBACKED: "Robinhood circulating supply exceeds Base backing on two consecutive reads. The bridge cannot cause this by itself.",
};

export function VerdictBadge({ verdict, className }: { verdict: ParityVerdict; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1.5 mono text-[12px] tracking-[0.1em]", VERDICT_STYLE[verdict], className)}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{verdict.replace("_", " ")}</span>;
}

function Row({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "ok" | "warn" | "crit" | "dim" }) {
  const cls = tone === "ok" ? "text-phosphor" : tone === "warn" ? "text-warn" : tone === "crit" ? "text-crit" : tone === "dim" ? "text-ink-2" : "text-ink";
  return (
    <>
      <dt className="min-w-0 py-1 font-sans text-[13px] text-ink-2 max-[601px]:max-w-[52vw]">{k}</dt>
      <dd className={cx("min-w-0 py-1 text-right break-words", cls)}>{v}</dd>
    </>
  );
}

function pct(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 10_000n) / whole) / 100;
}

function LaneCard({ lane, ethUsd, rhSupply, className }: { lane: OftLane; ethUsd: EthUsdQuote | null; rhSupply: bigint; className?: string }) {
  const c = lane.credit;
  const limit = c ? BigInt(c.limit) : 0n;
  const headroom = c ? BigInt(c.headroom) : 0n;
  const usedPct = c && limit > 0n ? 100 - pct(headroom, limit) : 0;
  const halted = lane.srcPaused === true || lane.dstPaused === true;
  const awaiting = lane.nonces.awaitingExecution.length;
  const fb = lane.feeBreakdown;
  const capBps = c && rhSupply > 0n ? Number((limit * 10_000n) / rhSupply) : null;
  return (
    <div className={cx("min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <ChainBadge chainId={lane.srcChainId} />
        <span className="mono text-[12px] text-ink-meta">→</span>
        <ChainBadge chainId={lane.dstChainId} />
        <span className={cx("ml-auto mono text-[12px] tracking-[0.08em]", halted ? "text-crit" : awaiting ? "text-warn" : "text-phosphor")}>
          {halted ? "● PAUSED" : awaiting ? `● ${awaiting} STUCK` : "● FLOWING"}
        </span>
      </div>

      <p className="t-kicker mt-5">Credit budget (rate limit) · enforced on {chainShort(lane.dstChainId)} adapter</p>
      {c ? (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="min-w-0 mono tnum text-[24px] text-ink">{fmtCompact(headroom, 18)} <span className="font-sans text-[12px] text-ink-meta">headroom</span></span>
            <span className="shrink-0 mono text-[12px] text-ink-2">of {fmtCompact(limit, 18)} / {fmtDuration(c.windowSec)}</span>
          </div>
          <div data-rv="bar" className="relative mt-2 h-1.5 overflow-hidden bg-white/[0.06]" title={`${usedPct.toFixed(2)}% of the window budget in flight`}>
            <div className={cx("bar-fill absolute inset-0", usedPct >= 75 ? "bg-warn" : "bg-phosphor")} style={{ "--v": Math.max(usedPct > 0 ? 1 : 0, Math.min(100, usedPct)) / 100 } as CSSProperties} />
          </div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 mono text-[12px]">
            <Row k="In flight (decayed)" v={`${fmtUnits(c.inFlight, 18, 2)} VIBES`} tone={BigInt(c.inFlight) > 0n ? "warn" : undefined} />
            <Row k="Refill" v={`${fmtCompact(c.refillPerSec, 18)} VIBES/s`} />
            <Row k="Full again in" v={c.secondsToFull ? fmtDuration(c.secondsToFull) : "now"} />
            <Row k="Last credit / checkpoint" v={c.lastCreditAt ? fmtUtc(c.lastCreditAt) : "—"} tone="dim" />
            {capBps !== null && <Row k="Max release per window" v={`${(capBps / 100).toFixed(2)}% of supply`} />}
          </dl>
        </>
      ) : (
        <p className="mt-2 mono text-[12px] text-warn">Credit budget unavailable at this block.</p>
      )}

      <p className="t-kicker mt-6">LayerZero fee · quoteSend() on {chainShort(lane.srcChainId)}</p>
      {BigInt(lane.nativeFeeWei) > 0n ? (
        <>
          <p className="mt-1.5 mono tnum text-[20px] text-ink [overflow-wrap:anywhere]">{ethWithUsd(lane.nativeFeeWei, ethUsd, 7)}</p>
          <p className="mt-0.5 text-[12px] text-ink-meta">per message, independent of amount · minimum (enforced {lane.enforcedLzReceiveGas ? `${BigInt(lane.enforcedLzReceiveGas).toLocaleString("en-US")} gas` : "gas"})</p>
          {fb && (
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 mono text-[12px]">
              <Row k="Executor" v={`${fmtUnits(fb.executorWei, 18, 7)} Ξ`} tone="dim" />
              {fb.dvns.map((d) => (
                <Row key={d.address} k={`DVN · ${d.name ?? "unlabelled"}`} v={`${fmtUnits(d.feeWei, 18, 7)} Ξ`} tone="dim" />
              ))}
              <Row k="Treasury" v={`${fmtUnits(fb.treasuryWei, 18, 7)} Ξ`} tone="dim" />
            </dl>
          )}
        </>
      ) : (
        <p className="mt-1 mono text-[12px] text-warn">quoteSend() unavailable at this block.</p>
      )}

      <p className="t-kicker mt-6">Verification security</p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 mono text-[12px]">
        <Row
          k="Required DVNs"
          v={lane.requiredDvns.length ? `${lane.requiredDvns.length}-of-${lane.requiredDvns.length} · ${lane.requiredDvns.map((d) => d.name ?? d.address.slice(0, 10)).join(" + ")}` : "unreadable"}
          tone={lane.requiredDvns.length === 0 ? "warn" : lane.requiredDvns.length === 1 && lane.optionalDvns.length === 0 ? "warn" : undefined}
        />
        <Row
          k="Optional DVNs"
          v={lane.optionalDvns.length ? `${lane.optionalDvnThreshold ?? "?"}-of-${lane.optionalDvns.length} · ${lane.optionalDvns.map((d) => d.name ?? d.address.slice(0, 10)).join(", ")}` : "none"}
          tone="dim"
        />
        <Row k={`Block confirmations (${chainShort(lane.srcChainId)})`} v={lane.confirmations ?? "—"} />
        <Row k="Send/receive config" v={lane.configMatches === null ? "unreadable" : lane.configMatches ? "match" : "MISMATCH"} tone={lane.configMatches === false ? "crit" : lane.configMatches ? "ok" : "dim"} />
        <Row k="Peers wired" v={lane.peersOk ? "both ways" : "MISMATCH"} tone={lane.peersOk ? "ok" : "crit"} />
        <Row k="Paused (src / dst)" v={`${lane.srcPaused === null ? "?" : lane.srcPaused ? "YES" : "no"} / ${lane.dstPaused === null ? "?" : lane.dstPaused ? "YES" : "no"}`} tone={halted ? "crit" : undefined} />
      </dl>

      <p className="t-kicker mt-6">Packets</p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 mono text-[12px]">
        <Row k="Sent (outbound nonce)" v={lane.nonces.outbound} />
        <Row k="Verified / executed" v={`${lane.nonces.inboundVerified} / ${lane.nonces.lazyExecuted}`} />
        <Row k="Waiting for DVNs" v={lane.nonces.unverified} tone={lane.nonces.unverified > 0 ? "warn" : "dim"} />
        <Row k="Verified, not delivered" v={awaiting ? lane.nonces.awaitingExecution.map((x) => `#${x.nonce}`).join(", ") : "0"} tone={awaiting ? "warn" : "dim"} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <AddrLink chainId={lane.srcChainId} address={lane.srcAdapter} label={`${chainShort(lane.srcChainId)} adapter`} />
        <AddrLink chainId={lane.dstChainId} address={lane.dstAdapter} label={`${chainShort(lane.dstChainId)} adapter`} />
      </div>
    </div>
  );
}

function GovCell({ chainId, g }: { chainId: 8453 | 4663; g: OftGovernance }) {
  const ownerKind = g.ownerSafe ? `Safe ${g.ownerSafe.threshold}-of-${g.ownerSafe.owners}` : g.ownerIsContract === false ? "EOA (single key)" : g.ownerIsContract ? "contract" : "unknown";
  const delegateSame = g.delegate && g.owner && g.delegate.toLowerCase() === g.owner.toLowerCase();
  return (
    <div className="min-w-0">
      <ChainBadge chainId={chainId} />
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 mono text-[12px]">
        <dt className="py-1 font-sans text-[13px] text-ink-2">Owner</dt>
        <dd className="min-w-0 py-1 text-right [overflow-wrap:anywhere]">
          <span className={g.ownerSafe && g.ownerSafe.threshold >= 2 ? "text-phosphor" : g.ownerIsContract === false ? "text-warn" : "text-ink"}>{ownerKind}</span>{" "}
          {g.owner && <AddrLink chainId={chainId} address={g.owner} />}
        </dd>
        <dt className="py-1 font-sans text-[13px] text-ink-2">LZ delegate</dt>
        <dd className="min-w-0 py-1 text-right text-ink-2 [overflow-wrap:anywhere]">{g.delegate ? (delegateSame ? "same as owner" : <AddrLink chainId={chainId} address={g.delegate} />) : "—"}</dd>
        <dt className="py-1 font-sans text-[13px] text-ink-2">Pauser</dt>
        <dd className="min-w-0 py-1 text-right text-ink-2 [overflow-wrap:anywhere]">
          {g.pauserIsContract === false ? "EOA · halt-only" : g.pauserIsContract ? "contract · halt-only" : "—"} {g.pauser && <AddrLink chainId={chainId} address={g.pauser} />}
        </dd>
      </dl>
    </div>
  );
}

/**
 * Bridge lane X-Ray: everything that decides whether bridged $VIBES is safe, read live from both adapters and both
 * LayerZero endpoints at pinned blocks — credit budgets, real fee, DVN set, peers, pause state, governance and stuck packets.
 */
export function BridgeLaneXray({ p }: { p: ParityReport; /** @deprecated accepted, ignored */ n?: string }) {
  const b: OftBridgeReport | null = p.bridge ?? null;
  if (!b) {
    return (
      <Panel title="Bridge lane X-Ray" variant="instrument">
        <p className="text-[14px] leading-relaxed text-warn">LayerZero adapter and endpoint reads failed at this refresh. No lane data is shown rather than stale or estimated values; it retries every 30s.</p>
      </Panel>
    );
  }
  const rhSupply = BigInt(p.rhTotalSupply);
  return (
    <Panel
      title="Bridge lane X-Ray · LayerZero V2"
      variant="instrument"
      right={
        <span className="mono text-[12px] text-ink-meta">
          Base #{BigInt(b.blocks.base.number).toLocaleString("en-US")} · RH #{BigInt(b.blocks.robinhood.number).toLocaleString("en-US")}
        </span>
      }
    >
      <p className="mb-6 max-w-[72ch] text-[14px] leading-relaxed text-ink-2">
        A bridge is only as safe as its weakest lane. For each direction Kestrel reads the destination adapter&apos;s credit budget (the most VIBES that can be released per window, and therefore the cap on damage from a forged message if the verifier set were ever compromised), the live LayerZero fee, who must sign off on each packet, and who can change or pause it.
      </p>
      <div className="grid gap-8 lg:grid-cols-2">
        {b.lanes.map((l, k) => (
          <LaneCard key={l.direction} lane={l} ethUsd={p.ethUsd ?? null} rhSupply={rhSupply} className={k > 0 ? "border-t border-hair pt-8 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0" : undefined} />
        ))}
      </div>
      <div className="mt-8 border-t border-hair pt-5">
        <p className="t-kicker mb-3">Governance · who can reconfigure or halt the bridge</p>
        <div className="grid gap-8 sm:grid-cols-2">
          <GovCell chainId={8453} g={b.governance[8453]} />
          <div className="min-w-0 sm:border-l sm:border-hair sm:pl-8">
            <GovCell chainId={4663} g={b.governance[4663]} />
          </div>
        </div>
        <p className="mt-4 max-w-[72ch] text-[13px] leading-relaxed text-ink-meta">
          The rate limit is enforced on delivery, not on send: an over-budget packet still locks tokens at the source, then waits at the destination endpoint with RateLimitExceeded until the window decays (anyone can retry it). On 2026-09-05 four Base → Robinhood packets were delayed 4 min to 3.6 h this way while the limit was 10M/h; it was later raised to 30M/h.
        </p>
      </div>
    </Panel>
  );
}
