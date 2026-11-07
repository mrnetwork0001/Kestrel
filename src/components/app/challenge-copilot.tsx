"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Abi, type Address, BaseError, ContractFunctionRevertedError, encodeFunctionData, getAddress, type Hex, parseUnits } from "viem";
import { useAccount, useCapabilities, useConnect, usePublicClient, useSendCalls, useSwitchChain, useWaitForCallsStatus, useWriteContract } from "wagmi";
import { AddrLink, cx, Panel, TxLink } from "@/components/ui";
import { DataList, type DataRow } from "@/components/data/data-list";
import { ERC20_ABI } from "@/lib/abis";
import { explorerBlock, fmtUnits, fmtUtc, shortAddr } from "@/lib/format";
import {
  CHALLENGE_CHAIN_CONFIG,
  decodeRevertData,
  ESCROW_CHALLENGE_COMMON_ABI,
  ESCROW_CHALLENGE_V2_ABI,
  REVERT_TEXT,
  ROUTER_CLAIM_ABI,
} from "@/lib/vibestarter/challenge-abis";
import type { ChallengePhase, CopilotReport, DryRunOutcome, DryRunResult, DryRunScenario, ReadinessStep, Verdict } from "@/lib/vibestarter/challenge";
import { getJson } from "./use-api";

/* ──────────────────────────────── helpers ──────────────────────────────── */

const ESCROW_WRITE_ABI = [...ESCROW_CHALLENGE_V2_ABI, ...ESCROW_CHALLENGE_COMMON_ABI] as Abi;
const ROUTER_ABI = [...ROUTER_CLAIM_ABI, ...ESCROW_CHALLENGE_COMMON_ABI.filter((x) => x.type === "error")] as Abi;
const TOKEN_ABI = [...ERC20_ABI, ...ESCROW_CHALLENGE_COMMON_ABI.filter((x) => x.type === "error")] as Abi;

const PHASE_STYLE: Record<ChallengePhase, string> = {
  NOT_FUNDED: "border-hair-strong text-ink-meta",
  FAILED: "border-hair-strong text-ink-2",
  AWAITING_UNLOCK: "border-base/40 text-base",
  AWAITING_REQUEST: "border-base/50 text-base",
  WINDOW_OPEN: "border-warn/60 text-warn",
  CHALLENGE_PENDING: "border-crit/60 text-crit",
  AWAITING_CLAIM: "border-base/40 text-base",
  COMPLETED: "border-phosphor/40 text-phosphor",
  FROZEN: "border-crit/60 text-crit",
  REFUNDING: "border-crit/40 text-crit",
};

const CHALLENGE_STATE = ["None", "Pending", "Upheld", "Rejected"];
const CAMPAIGN_STATE = ["Uninitialized", "Active", "Paused", "Funded", "Failed", "Frozen", "Refunding", "Completed"];

function revertDataOf(e: unknown): Hex | null {
  let cur: unknown = e;
  for (let i = 0; i < 10 && cur && typeof cur === "object"; i++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x")) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return (d as { data: Hex }).data;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Human-readable revert: `ErrorName(args) — meaning`. */
function decodeErr(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    if (name) {
      const args = (rev?.data?.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
      return `${name}(${args})${REVERT_TEXT[name] ? ` — ${REVERT_TEXT[name]}` : ""}`;
    }
    const raw = decodeRevertData(revertDataOf(e));
    if (raw && !raw.startsWith("unknown")) {
      const n = raw.split("(")[0];
      return `${raw}${REVERT_TEXT[n] ? ` — ${REVERT_TEXT[n]}` : ""}`;
    }
    return (e.shortMessage || e.message).split("\n")[0].slice(0, 220);
  }
  return e instanceof Error ? e.message.slice(0, 220) : String(e).slice(0, 220);
}

/**
 * The Backer Shield's NEXT figure holds the tab's single live countdown; the co-pilot shows fixed UTC dates instead.
 * `now0` is the escrow oracle time from the same read, so past/future is decided on chain time, not the browser clock.
 */
function UtcAt({ to, now0, done = "elapsed" }: { to: number; now0: number; done?: string }) {
  return <span>{to > now0 ? fmtUtc(to) : done}</span>;
}

const FIG_TONE = { phosphor: "text-phosphor", warn: "text-warn", crit: "text-crit", base: "text-base", rh: "text-rh" } as const;

/** Unboxed figure (kicker label, mono value, meta sub-line): the co-pilot is one instrument, so nothing inside it gets a box. */
function Fig({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: keyof typeof FIG_TONE }) {
  return (
    <div className="min-w-0">
      <p className="t-kicker">{label}</p>
      <p className={cx("mt-2 tnum text-[20px] leading-tight [overflow-wrap:anywhere] max-[601px]:text-[18px]", tone ? FIG_TONE[tone] : "text-ink")}>{value}</p>
      {sub && <p className="mt-1 mono text-[12px] leading-snug text-ink-meta">{sub}</p>}
    </div>
  );
}

/** Captured at module load: the workspace rewrites the query string on mount, so read `dryrun=1` before that. */
const dryRunDeepLink = { pending: typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dryrun") === "1" };

const eth = (wei: string | null | undefined, frac = 4) => (wei == null ? "unavailable" : `${fmtUnits(wei, 18, frac)} Ξ`);

/* ──────────────────────────────── write side ──────────────────────────────── */

type ActKey = "raise" | "support" | "oppose" | "expire" | "refund" | "claim";

interface PlannedCall {
  label: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  data: Hex;
}

interface ActState {
  sim: "idle" | "pending" | "ok" | "fail";
  simMsg?: string;
  gas?: string[];
  tx: "idle" | "signing" | "sent" | "confirmed" | "failed";
  hashes?: string[];
  txMsg?: string;
  batchId?: string;
}

const IDLE: ActState = { sim: "idle", tx: "idle" };

function plan(label: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[]): PlannedCall {
  return { label, to, abi, functionName, args, data: encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]) };
}

/* ──────────────────────────────── component ──────────────────────────────── */

export function ChallengeCopilot({ escrow, chainId }: { escrow: string; chainId: number; title?: string | null }) {
  const cid = (chainId === 4663 ? 4663 : 8453) as 8453 | 4663;
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const qc = useQueryClient();
  const key = ["challenge", cid, escrow.toLowerCase(), address?.toLowerCase() ?? null];
  const { data: r, error, isFetching } = useQuery({
    queryKey: key,
    queryFn: () => getJson<CopilotReport>(`/api/challenge?escrow=${escrow}&chainId=${cid}${address ? `&wallet=${address}` : ""}`),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  if (error && !r) return <Panel title="Live // Backer Challenge Co-pilot"><p className="mono text-[12px] text-crit">Co-pilot read failed: {error.message}</p></Panel>;
  if (!r) return <Panel title="Live // Backer Challenge Co-pilot"><p className="mono text-[12px] text-ink-meta cursor-blink">Reading challenge state, bond economics and trust surface live</p></Panel>;

  return (
    <Panel
      title="Live // Backer Challenge Co-pilot"
     
      className="max-[601px]:border-x-0"
      right={
        <span className="whitespace-nowrap mono text-[11px] text-ink-meta">
          {isFetching ? "refreshing…" : <a href={explorerBlock(r.chainId, r.block.number)} target="_blank" rel="noreferrer" className="hover:text-ink">block #{BigInt(r.block.number).toLocaleString("en-US")} ↗</a>}
        </span>
      }
    >
      <div className="space-y-6">
        <StatusStrip r={r} />
        {r.challenge && <LiveChallenge r={r} />}
        <div className="grid gap-6 xl:grid-cols-2">
          <Position r={r} isConnected={isConnected} />
          <OutcomeCalculator r={r} />
        </div>
        <DryRun r={r} />
        <Actions r={r} address={address} isConnected={isConnected} walletChainId={walletChainId} onDone={() => qc.invalidateQueries({ queryKey: ["challenge", cid, escrow.toLowerCase()] })} />
        <RulesAndTrust r={r} />
        <p className="border-t hairline pt-3 mono text-[11px] leading-relaxed text-ink-meta">
          Kestrel never adjudicates or recommends challenging; not financial advice. Every figure above is read live from {r.chainId === 4663 ? "Robinhood Chain" : "Base"} at block #{BigInt(r.block.number).toLocaleString("en-US")} (escrow oracle time {fmtUtc(r.oracleTime)}).
          {r.notes.map((n) => ` ${n}`).join("")}
        </p>
      </div>
    </Panel>
  );
}

function StatusStrip({ r }: { r: CopilotReport }) {
  const n = r.next;
  const sym = r.token.symbol;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx("mono text-[12px] tracking-wider", PHASE_STYLE[r.phase])}>● {r.phase.replace(/_/g, " ")}</span>
        <span className="mono text-[11px] text-ink-meta">{r.gen === "v1" ? "v1 escrow · Vibestarter terms signature gate" : r.gen === "v2" ? "v2 escrow · on-chain eligibility credential gate" : "unrecognized escrow"}</span>
        {r.impl && <AddrLink chainId={r.chainId} address={r.impl} label={`impl ${shortAddr(r.impl, 4)}`} className="text-[11px]" />}
      </div>
      <p className="mt-2 text-[13px] text-ink-2">{r.phaseDetail}</p>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        {n ? (
          <>
            <Fig
              label={n.requestedAt > 0 ? "Window closes" : `T${n.tranche} unlocks`}
              value={n.requestedAt > 0 && n.windowEndsAt ? <UtcAt to={n.windowEndsAt} now0={r.oracleTime} done="window closed" /> : <UtcAt to={n.unlockTime} now0={r.oracleTime} done="unlocked · awaiting request" />}
              tone={r.phase === "WINDOW_OPEN" ? "warn" : "base"}
              sub="countdown: see Next above"
            />
            <Fig label={`Next tranche · T${n.tranche}`} value={eth(n.amountWei)} sub={n.claimed ? "claimed" : n.challenged ? "under challenge" : "not yet paid"} />
            <Fig label={`Bond · ${(n.thresholdBps / 100).toFixed(2)}% of supply`} value={`${fmtUnits(n.bond, r.token.decimals, 0)} ${sym}`} sub={n.bondEthSpot ? `≈ ${eth(n.bondEthSpot)} at spot${n.bondEthExit ? ` · ${eth(n.bondEthExit)} if sold` : ""}` : "spot value unavailable"} />
            <Fig label="Slash at risk (20%)" value={`${fmtUnits(n.slashAtRisk, r.token.decimals, 0)} ${sym}`} tone="crit" sub={n.slashEthSpot ? `≈ ${eth(n.slashEthSpot)} burned if rejected` : "burned to 0xdead if rejected"} />
          </>
        ) : (
          <>
            <Fig label="Onchain state" value={r.stateLabel} tone={[4, 5, 6].includes(r.state) ? "crit" : undefined} />
            <Fig label="Escrow ETH" value={eth(r.escrowEth.balance)} />
            <Fig label="Challenges filed" value={r.challengeSeq} />
            <Fig label="Token" value={sym} sub={`${fmtUnits(r.token.totalSupply, r.token.decimals, 0)} supply`} />
          </>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 mono text-[11px] text-ink-meta">
        <span>
          adjudicator{" "}
          {r.admin ? <AddrLink chainId={r.chainId} address={r.admin} /> : "unavailable"}{" "}
          {r.adminIsContract === false && <span className="text-warn">EOA · single key</span>}
          {r.adminSafe && <span className="text-phosphor">Safe {r.adminSafe.threshold}-of-{r.adminSafe.owners.length}</span>}
        </span>
        <span>
          gate {r.gating.kind === "eligibility-registry" ? "on-chain credential" : r.gating.kind === "terms-signature" ? "Vibestarter terms signature" : r.gating.kind}
          {r.gating.address && r.gating.address !== "0x0000000000000000000000000000000000000000" && <> · <AddrLink chainId={r.chainId} address={r.gating.address} /></>}
        </span>
        <span>window {Math.round(r.constants.challengeWindow / 3600)}h · adjudication {Math.round(r.constants.adjudicationWindow / 3600)}h · cooldown {Math.round(r.constants.cooldown / 86400)}d</span>
      </div>
    </div>
  );
}

function LiveChallenge({ r }: { r: CopilotReport }) {
  const c = r.challenge!;
  const [full, setFull] = useState(false);
  const reason = full ? c.reason : c.reason.slice(0, 280);
  return (
    <div className={cx("border-l-2 pl-4", c.active ? "border-crit" : "border-hair-strong")}>
      <p className={cx("t-kicker", c.active ? "text-crit" : "text-ink-meta")}>{c.active ? `Live challenge #${c.seq} · tranche ${c.tranche}` : `Previous challenge #${c.seq} · ${c.stateLabel}`}</p>
      <div className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Fig label="Challenger" value={<AddrLink chainId={r.chainId} address={c.challenger} />} />
        <Fig label="Bond staked" value={`${fmtUnits(c.bond, r.token.decimals, 0)} ${r.token.symbol}`} />
        <Fig label="Filed" value={fmtUtc(c.filedAt).slice(5)} />
        <Fig label={c.active ? "Expirable after" : "State"} value={c.active ? <UtcAt to={c.deadline} now0={r.oracleTime} done="expirable now" /> : c.stateLabel} tone={c.active ? "crit" : undefined} sub={c.active ? "adjudication deadline" : undefined} />
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-[12px] text-ink-2">&ldquo;{reason}{!full && c.reason.length > 280 ? "…" : ""}&rdquo;</p>
      {c.reason.length > 280 && <button onClick={() => setFull((v) => !v)} className="mt-1 mono text-[11px] text-ink-meta hover:text-ink">{full ? "collapse" : "show full reason"}</button>}
      {r.votes && (
        <div className="mt-3 border-t hairline pt-3 mono text-[11px] text-ink-2">
          <p>
            support {r.votes.support} ({fmtUnits(r.votes.supportWeight, r.token.decimals, 0)} {r.token.symbol}) · oppose {r.votes.oppose} ({fmtUnits(r.votes.opposeWeight, r.token.decimals, 0)} {r.token.symbol})
            {r.wallet && ` · your vote: ${["none", "support", "oppose"][r.wallet.currentVote]}`}
          </p>
          <p className="mt-1 text-[11px] text-ink-meta">{r.votes.note}{r.votes.complete ? "" : ` Logs scanned from block ${r.votes.scannedFromBlock} only.`}</p>
        </div>
      )}
    </div>
  );
}

function CheckRow({ s }: { s: ReadinessStep }) {
  return (
    <li className="flex items-start gap-2 text-[13px] max-[601px]:flex-wrap max-[601px]:gap-y-0.5">
      <span className={cx("w-4 shrink-0 mono", s.status === "pass" ? "text-phosphor" : s.status === "fail" ? "text-crit" : "text-ink-meta")}>{s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "?"}</span>
      <span className="min-w-0 flex-1 text-ink">
        {s.label}
        {s.detail && <span className="text-ink-2"> · {s.detail}</span>}
      </span>
      <span className={cx("shrink-0 mono text-[12px] max-[601px]:basis-full max-[601px]:pl-6 max-[601px]:[overflow-wrap:anywhere]", s.status === "fail" ? "text-crit" : "text-ink-meta")}>{s.revert}</span>
    </li>
  );
}

function Position({ r, isConnected }: { r: CopilotReport; isConnected: boolean }) {
  const { connectors, connect, isPending } = useConnect();
  const w = r.wallet;
  const firstFail = r.raiseChecklist.find((s) => s.status === "fail" && s.id !== "allowance");
  return (
    <div className="min-w-0 border-t border-hair pt-4">
      <p className="t-kicker">Your position · readiness in contract revert order</p>
      {!isConnected ? (
        <div className="mt-3">
          <p className="text-[13px] text-ink-2">Read-only so far. Connect a wallet to check your credential, cooldown, bond balance and claimable funds. Nothing is signed by connecting.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {connectors.map((c) => (
              <button key={c.uid} onClick={() => connect({ connector: c, chainId: r.chainId === 4663 ? 4663 : 8453 })} disabled={isPending} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor disabled:opacity-40">
                {c.name}
              </button>
            ))}
          </div>
        </div>
      ) : w ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px] max-[901px]:grid-cols-[auto_minmax(0,1fr)] max-[901px]:[overflow-wrap:anywhere] max-[601px]:gap-x-3">
          <dt className="text-ink-2">Wallet</dt>
          <dd><AddrLink chainId={r.chainId} address={w.address} /> <span className="mono text-[12px] text-ink-meta">{fmtUnits(w.nativeBalance, 18, 5)} Ξ gas</span></dd>
          <dt className="text-ink-2">{r.token.symbol}</dt>
          <dd className="tnum text-ink">{fmtUnits(w.balance, r.token.decimals, 2)}{r.next && <span className="text-ink-meta"> / bond {fmtUnits(r.next.bond, r.token.decimals, 0)}</span>}</dd>
          <dt className="text-ink-2">Allowance → escrow</dt>
          <dd className="tnum text-ink-2">{fmtUnits(w.allowance, r.token.decimals, 2)}</dd>
          <dt className="text-ink-2">{r.gen === "v1" ? "Terms nonce" : "Credential"}</dt>
          <dd className={cx(r.gen === "v1" ? "text-ink-2" : w.eligible ? "text-phosphor" : "text-warn")}>
            {r.gen === "v1" ? `nonce ${w.v1Nonce ?? "unavailable"} · signature must come from Vibestarter` : w.credential ? `tier ${w.credential.tier} · expires ${fmtUtc(w.credential.expiresAt).slice(0, 10)}${w.eligible ? " · eligible" : " · not eligible"}` : w.eligible ? "eligible" : "no live credential"}
          </dd>
          <dt className="text-ink-2">Contribution</dt>
          <dd className="text-ink-2">{w.contribution && BigInt(w.contribution.amount) > 0n ? `${eth(w.contribution.amount)}${w.contribution.refundClaimed ? " · refund claimed" : ""}` : "none"}</dd>
          <dt className="text-ink-2">Backer tokens</dt>
          <dd className="text-ink-2">{w.claimableTokens == null ? "unavailable" : w.hasClaimedTokens ? "claimed" : `${fmtUnits(w.claimableTokens, r.token.decimals, 2)} claimable`}</dd>
          <dt className="text-ink-2">Cooldown</dt>
          <dd className="text-ink-2">{w.cooldownEndsAt ? <UtcAt to={w.cooldownEndsAt} now0={r.oracleTime} done="elapsed" /> : "never challenged"}</dd>
        </dl>
      ) : (
        <p className="mt-3 mono text-[12px] text-ink-meta cursor-blink">Reading wallet</p>
      )}
      <ol className="mt-4 space-y-2 border-t hairline pt-3">
        {r.raiseChecklist.map((s) => <CheckRow key={s.id} s={s} />)}
      </ol>
      <p className="mt-3 mono text-[12px]">
        {w?.canRaise.ok ? (
          <span className="text-phosphor">Predicted: raiseChallenge would succeed{w.canRaise.needsApproval ? " (after approve)" : ""}.</span>
        ) : firstFail ? (
          <span className="text-warn">Predicted revert: {firstFail.revert} — {REVERT_TEXT[firstFail.revert] ?? firstFail.label}</span>
        ) : (
          <span className="text-ink-meta">{w?.canRaise.reason ?? "Connect a wallet for the full prediction."}</span>
        )}
      </p>
      {w?.ethCallProbe && (
        <p className="mt-1 mono text-[12px] text-ink-meta">
          eth_call from your wallet now → raiseChallenge: {w.ethCallProbe.raise.ok ? "would succeed" : w.ethCallProbe.raise.revert} · supportChallenge: {w.ethCallProbe.support.ok ? "would succeed" : w.ethCallProbe.support.revert}
        </p>
      )}
    </div>
  );
}

function OutcomeCalculator({ r }: { r: CopilotReport }) {
  const [amt, setAmt] = useState("");
  const snap = r.upheldSnapshot;
  const dec = r.token.decimals;
  useEffect(() => {
    if (r.wallet && !amt) setAmt(fmtUnits(r.wallet.balance, dec, 4).replace(/,/g, ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.wallet?.balance]);
  let units: bigint | null = null;
  try {
    units = amt.trim() ? parseUnits(amt.trim().replace(/,/g, ""), dec) : null;
  } catch {
    units = null;
  }
  const refund = snap && units != null && BigInt(snap.frozenTotalSupply) > 0n ? (units * BigInt(snap.frozenEthBalance)) / BigInt(snap.frozenTotalSupply) : null;
  const n = r.next;
  return (
    <div className="min-w-0 border-t border-hair pt-4">
      <p className="t-kicker">Outcome calculator</p>
      {n ? (
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-2">
          <li><span className="text-crit">If you challenge and the admin rejects:</span> you lose {fmtUnits(n.slashAtRisk, dec, 0)} {r.token.symbol}{n.slashEthSpot ? ` (≈ ${eth(n.slashEthSpot)})` : ""}, 80% of the bond comes back.</li>
          <li><span className="text-phosphor">If upheld:</span> the full bond is returned, the raise freezes and every holder can claim pro-rata ETH.</li>
          <li><span className="text-ink">If nobody rules within {Math.round(r.constants.adjudicationWindow / 3600)}h:</span> anyone can expire it; the full bond is returned, no slash.</li>
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-ink-meta">No challengeable tranche in state {r.stateLabel}.</p>
      )}
      <div className="mt-4 border-t hairline pt-3">
        <label className="t-kicker" htmlFor="kest-calc">Refund estimate if a challenge is upheld</label>
        <div className="mt-2 flex items-center gap-2 max-[601px]:flex-wrap">
          <input id="kest-calc" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={`${r.token.symbol} amount`} className="w-44 rounded-[2px] border border-hair-strong bg-transparent px-2 py-1.5 mono text-[14px] text-ink focus:border-phosphor/60 focus:outline-none max-[901px]:text-[16px] max-[601px]:w-full" />
          <span className="mono text-[12px] text-ink-meta">{r.token.symbol} →</span>
          <span className="tnum text-[16px] text-ink">{snap ? (refund != null ? eth(refund.toString(), 6) : "enter an amount") : "unavailable"}</span>
        </div>
        <p className="mt-2 mono text-[12px] leading-relaxed text-ink-meta">
          {snap
            ? `amount × frozenEthBalance (${eth(snap.frozenEthBalance)}) / frozenTotalSupply (${fmtUnits(snap.frozenTotalSupply, dec, 0)} ${r.token.symbol}), both computed by the escrow's own upholdChallenge() in eth_simulateV1 at block ${snap.block}. Estimate: the final figure is set at the real freeze and shrinks with every tranche paid before it.`
            : "Unavailable: an uphold snapshot only exists for Funded escrows with a challengeable tranche."}
        </p>
      </div>
    </div>
  );
}

/* ──────────────────────────────── dry-run ──────────────────────────────── */

function DryRun({ r }: { r: CopilotReport }) {
  const [res, setRes] = useState<DryRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<DryRunOutcome>("raise");
  const [showOv, setShowOv] = useState(false);
  useEffect(() => {
    setRes(null);
    setErr(null);
    // Deep link `…&dryrun=1` auto-runs the simulation once per page load (shareable demo; read-only).
    if (dryRunDeepLink.pending) {
      dryRunDeepLink.pending = false;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.escrow, r.chainId]);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const d = await getJson<DryRunResult>("/api/challenge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dry-run", escrow: r.escrow, chainId: r.chainId }) });
      setRes(d);
      setTab(d.scenarios[0]?.outcome ?? "raise");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const sc = res?.scenarios.find((s) => s.outcome === tab) ?? res?.scenarios[0];
  return (
    <div className="border-t border-phosphor/40 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="t-kicker text-phosphor">Challenge Dry-Run · no wallet needed</p>
          <p className="mt-1 max-w-2xl text-[12px] text-ink-2">
            No 72-hour window is open right now, so Kestrel runs the deployed escrow code itself in <span className="mono">eth_simulateV1</span> with a few storage slots overridden: a synthetic challenger files, holders vote, then the admin rejects, upholds, or nobody rules.
          </p>
        </div>
        <button onClick={run} disabled={busy} className="rounded-[2px] border border-phosphor/60 px-4 py-2 mono text-[12px] text-phosphor hover:bg-phosphor/10 disabled:opacity-40 max-[901px]:min-h-[44px] max-[601px]:w-full">
          {busy ? "simulating…" : res ? "↻ RE-RUN DRY-RUN" : "▶ RUN DRY-RUN"}
        </button>
      </div>
      {err && <p className="mt-3 mono text-[11px] text-crit">{err}</p>}
      {res && (
        <div className="mt-4">
          <p className={cx("mono text-[11px]", res.selfCheck === "ok" ? "text-phosphor" : "text-crit")}>
            {res.selfCheck === "ok" ? "✓ storage-layout self-check passed" : `✗ ${res.selfCheck}: ${res.selfCheckDetail}`} · {res.method} at block{" "}
            <a href={explorerBlock(res.chainId, res.block.number)} target="_blank" rel="noreferrer" className="underline decoration-white/20 hover:text-ink">#{BigInt(res.block.number).toLocaleString("en-US")}</a> · {res.elapsedMs} ms · bond {fmtUnits(res.bond, res.token.decimals, 0)} {res.token.symbol}
          </p>
          {res.reason && <p className="mt-2 text-[12px] text-warn">{res.reason}</p>}
          <div className="mt-3 flex flex-wrap gap-1">
            {res.scenarios.map((s) => (
              <button key={s.outcome} onClick={() => setTab(s.outcome)} className={cx("rounded-[2px] border px-3 py-1.5 mono text-[11px] max-[601px]:flex-[1_1_45%]", tab === s.outcome ? "border-phosphor/60 text-phosphor" : "border-hair-strong text-ink-meta hover:text-ink")}>
                {s.ok ? "✓" : "✗"} {s.title}
              </button>
            ))}
          </div>
          {sc && <Scenario sc={sc} res={res} />}
          <div className="mt-3">
            <button onClick={() => setShowOv((v) => !v)} className="mono text-[11px] text-ink-meta hover:text-ink">{showOv ? "hide" : "show"} {res.overrides.length} storage overrides</button>
            {showOv && (
              <ul className="mt-2 space-y-1">
                {res.overrides.map((o) => (
                  <li key={o.address + o.slot} className="break-all mono text-[11px] text-ink-meta">
                    <AddrLink chainId={res.chainId} address={o.address} className="text-[11px]" /> slot {o.slot.slice(0, 10)}…{o.slot.slice(-6)} := {o.value.length > 40 ? `${o.value.slice(0, 18)}…${o.value.slice(-8)}` : o.value} · <span className="text-ink-2">{o.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-3 mono text-[11px] leading-relaxed text-ink-meta">{res.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

function Scenario({ sc, res }: { sc: DryRunScenario; res: DryRunResult }) {
  const d = res.token.decimals;
  const sym = res.token.symbol;
  const f = (label: string) => sc.facts.find((x) => x.label === label)?.value;
  const facts: { k: string; v: string }[] = [];
  if (f("stakeHeld")) facts.push({ k: "Bond held by escrow", v: `${fmtUnits(f("stakeHeld")!, d, 0)} ${sym}` });
  if (f("burned")) facts.push({ k: "Burned to 0xdead", v: `${fmtUnits(f("burned")!, d, 0)} ${sym}` });
  if (f("challengerAfter")) facts.push({ k: "Challenger ends with", v: `${fmtUnits(f("challengerAfter")!, d, 0)} of ${fmtUnits(res.bond, d, 0)} ${sym}` });
  if (f("stateAfter") && sc.outcome === "uphold") facts.push({ k: "Campaign state", v: `${f("stateAfter")} (${CAMPAIGN_STATE[Number(f("stateAfter"))] ?? "?"})` });
  if (f("stateEarly")) facts.push({ k: "Challenge at half-window", v: `${f("stateEarly")} (${CHALLENGE_STATE[Number(f("stateEarly"))] ?? "?"}): expiry was a no-op` });
  if (f("stateAfter") && sc.outcome === "expire") facts.push({ k: "Challenge after window", v: `${f("stateAfter")} (${CHALLENGE_STATE[Number(f("stateAfter"))] ?? "?"}), no slash` });
  if (f("frozenEthBalance")) facts.push({ k: "frozenEthBalance", v: eth(f("frozenEthBalance")!, 6) });
  if (f("frozenTotalSupply")) facts.push({ k: "frozenTotalSupply", v: `${fmtUnits(f("frozenTotalSupply")!, d, 0)} ${sym}` });
  return (
    <div className="mt-3">
      <p className={cx("text-[13px]", sc.ok ? "text-ink" : "text-warn")}>{sc.summary}</p>
      {sc.error && <p className="mt-1 mono text-[11px] text-crit">{sc.error}</p>}
      {facts.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {facts.map((x) => (
            <div key={x.k} className="min-w-0 border-l border-hair py-1 pl-3 max-[601px]:pl-2">
              <p className="mono text-[11px] text-ink-meta">{x.k}</p>
              <p className="mt-0.5 tnum text-[13px] text-ink [overflow-wrap:anywhere]">{x.v}</p>
            </div>
          ))}
        </div>
      )}
      <ol className="mt-3 space-y-1">
        {sc.steps.map((s, i) => {
          const good = s.expectFailure ? s.status === "failure" : s.status === "success";
          return (
            <li key={i} className={cx("grid grid-cols-[28px_1fr] gap-2 border-l-2 py-1 pl-2 text-[11px] max-[901px]:grid-cols-[auto_minmax(0,1fr)] max-[901px]:[overflow-wrap:anywhere]", s.kind === "action" ? (good ? "border-phosphor/50" : "border-crit/60") : "border-white/10")}>
              <span className="mono text-ink-meta">b{s.block}</span>
              <div className="min-w-0">
                <p className={cx(s.kind === "action" ? "text-ink" : "text-ink-meta")}>
                  {s.label} <span className="mono text-[11px] text-ink-meta">· {s.actorLabel}</span>
                </p>
                <p className="break-all mono text-[11px] text-ink-meta">
                  {s.call} → <span className={good ? "text-phosphor" : "text-crit"}>{s.status}</span>
                  {s.gasUsed && s.kind === "action" ? ` · gas ${Number(s.gasUsed).toLocaleString("en-US")}` : ""}
                  {s.revert ? ` · ${s.revert}` : ""}
                  {s.decoded && s.kind !== "action" ? ` · ${s.decoded.slice(0, 140)}` : ""}
                </p>
                {s.events.length > 0 && <p className="break-all mono text-[11px] text-ink-meta">events: {s.events.map((e) => e.split("(")[0]).join(", ")}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ──────────────────────────────── actions ──────────────────────────────── */

function Actions({ r, address, isConnected, walletChainId, onDone }: { r: CopilotReport; address?: Address; isConnected: boolean; walletChainId?: number; onDone: () => void }) {
  const cid = (r.chainId === 4663 ? 4663 : 8453) as 8453 | 4663;
  const publicClient = usePublicClient({ chainId: cid });
  const caps = useCapabilities({ query: { enabled: isConnected } });
  const { sendCallsAsync } = useSendCalls();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const [st, setSt] = useState<Record<ActKey, ActState>>({ raise: IDLE, support: IDLE, oppose: IDLE, expire: IDLE, refund: IDLE, claim: IDLE });
  const [reason, setReason] = useState("");
  const [ctx, setCtx] = useState("");
  const [ack, setAck] = useState(false);
  const batchId = st.raise.batchId;
  const batch = useWaitForCallsStatus({ id: batchId, query: { enabled: !!batchId } });
  const w = r.wallet;
  const escrow = getAddress(r.escrow);
  const token = getAddress(r.token.address);

  const capsForChain = caps.data?.[cid] as { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined;
  const atomic = capsForChain?.atomic?.status === "supported" || capsForChain?.atomic?.status === "ready" || capsForChain?.atomicBatch?.supported === true;

  // Any input change invalidates a previous simulation.
  useEffect(() => setSt((s) => ({ ...s, raise: s.raise.tx === "idle" ? IDLE : s.raise })), [reason, w?.allowance]);
  useEffect(() => setSt((s) => ({ ...s, support: s.support.tx === "idle" ? IDLE : s.support, oppose: s.oppose.tx === "idle" ? IDLE : s.oppose })), [ctx]);
  useEffect(() => {
    if (batch.data?.status === "success") {
      setSt((s) => ({ ...s, raise: { ...s.raise, tx: "confirmed", hashes: batch.data?.receipts?.map((x) => x.transactionHash) } }));
      onDone();
    } else if (batch.data?.status === "failure") setSt((s) => ({ ...s, raise: { ...s.raise, tx: "failed", txMsg: "bundle reverted onchain" } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.data?.status]);

  const calls = useMemo((): Record<ActKey, PlannedCall[]> => {
    const bond = r.next ? BigInt(r.next.bond) : 0n;
    const needsApproval = w ? BigInt(w.allowance) < bond : true;
    const text = reason.trim().slice(0, 1000);
    const c2 = ctx.trim().slice(0, 1000);
    return {
      raise: [
        ...(needsApproval && bond > 0n ? [plan(`Approve escrow for exactly the bond (${fmtUnits(bond, r.token.decimals, 0)} ${r.token.symbol}, never unlimited)`, token, TOKEN_ABI, "approve", [escrow, bond])] : []),
        plan(`raiseChallenge on tranche ${r.next?.tranche ?? "?"}`, escrow, ESCROW_WRITE_ABI, "raiseChallenge", [text]),
      ],
      support: [plan("supportChallenge", escrow, ESCROW_WRITE_ABI, "supportChallenge", [c2])],
      oppose: [plan("opposeChallenge", escrow, ESCROW_WRITE_ABI, "opposeChallenge", [c2])],
      expire: [plan("expireChallengeIfNeeded (permissionless)", escrow, ESCROW_WRITE_ABI, "expireChallengeIfNeeded", [])],
      refund: [plan("claimContributorRefund", escrow, ESCROW_WRITE_ABI, "claimContributorRefund", [])],
      claim: [plan(`Router claimTokens(${r.token.symbol})`, CHALLENGE_CHAIN_CONFIG[cid].router, ROUTER_ABI, "claimTokens", [token])],
    };
  }, [r, w, reason, ctx, escrow, token, cid]);

  const set = (k: ActKey, patch: Partial<ActState>) => setSt((s) => ({ ...s, [k]: { ...s[k], ...patch } }));

  async function simulate(k: ActKey) {
    if (!publicClient || !address) return;
    const list = calls[k];
    set(k, { sim: "pending", simMsg: undefined, gas: undefined, tx: "idle", txMsg: undefined, hashes: undefined, batchId: undefined });
    try {
      if (list.length > 1) {
        // approve → raiseChallenge depends on the approval: eth_simulateV1 runs them in sequence.
        const res = await publicClient.simulateCalls({ account: address, calls: list.map((c) => ({ to: c.to, data: c.data })) });
        const badIdx = res.results.findIndex((x) => x.status !== "success");
        if (badIdx >= 0) {
          const bad = res.results[badIdx] as { data?: Hex; error?: unknown };
          const raw = decodeRevertData(bad.data ?? null);
          const n = raw?.split("(")[0] ?? "";
          set(k, { sim: "fail", simMsg: `${list[badIdx].functionName}: ${raw && !raw.startsWith("unknown") ? `${raw}${REVERT_TEXT[n] ? ` — ${REVERT_TEXT[n]}` : ""}` : bad.error ? decodeErr(bad.error) : "reverted"}` });
          return;
        }
        set(k, { sim: "ok", simMsg: "all calls pass in sequence", gas: res.results.map((x) => x.gasUsed.toString()) });
      } else {
        const c = list[0];
        const res = await publicClient.simulateContract({ account: address, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args } as Parameters<typeof publicClient.simulateContract>[0]);
        set(k, { sim: "ok", simMsg: "simulation passed", gas: res.request.gas ? [res.request.gas.toString()] : undefined });
      }
    } catch (e) {
      set(k, { sim: "fail", simMsg: decodeErr(e) });
    }
  }

  async function sign(k: ActKey) {
    if (!publicClient || !address || st[k].sim !== "ok") return;
    const list = calls[k];
    set(k, { tx: "signing", txMsg: undefined });
    try {
      if (walletChainId !== cid) await switchChainAsync({ chainId: cid });
      if (list.length > 1 && atomic) {
        const res = await sendCallsAsync({ chainId: cid, calls: list.map((c) => ({ to: c.to, data: c.data })) });
        set(k, { tx: "sent", batchId: res.id });
        return;
      }
      const hashes: string[] = [];
      for (const c of list) {
        // EOA path: re-simulate each step right before it is signed.
        await publicClient.simulateContract({ account: address, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args } as Parameters<typeof publicClient.simulateContract>[0]);
        const hash = await writeContractAsync({ chainId: cid, address: c.to, abi: c.abi, functionName: c.functionName, args: c.args } as Parameters<typeof writeContractAsync>[0]);
        hashes.push(hash);
        set(k, { tx: "sent", hashes: [...hashes] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`${c.functionName} reverted onchain`);
      }
      set(k, { tx: "confirmed", hashes });
      onDone();
    } catch (e) {
      set(k, { tx: "failed", txMsg: decodeErr(e) });
    }
  }

  const v1 = r.gen === "v1";
  const disabledAll = !isConnected || !address || r.gen === "unknown";

  return (
    <div className="min-w-0 border-t border-hair pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="t-kicker">Actions · simulate first, then sign</p>
        {isConnected && (
          <span className="mono text-[11px] text-ink-meta">
            EIP-5792 {caps.isLoading ? "probing…" : atomic ? <span className="text-phosphor">atomic batch supported · approve + raise in 1 signature</span> : <span className="text-warn">not supported · sequential signing</span>}
          </span>
        )}
      </div>

      {v1 ? (
        <div className="mt-3 border-l-2 border-warn pl-3 text-[13px] text-ink-2">
          This is the Genesis (v1) escrow: raiseChallenge / supportChallenge / opposeChallenge each require an EIP-712 TermsAcceptance signature that only Vibestarter&apos;s backend can issue (SIWE session + Starter Card + checks). Kestrel will not fake it.
          <a href={r.vibestarterUrl} target="_blank" rel="noreferrer" className="mt-2 block mono text-[12px] text-warn hover:underline max-[901px]:flex max-[901px]:min-h-[36px] max-[901px]:items-center">Continue on Vibestarter ↗</a>
        </div>
      ) : (
        <>
          {w && w.eligible === false && r.gating.kind === "eligibility-registry" && (
            <p className="mt-3 text-[12px] text-warn">
              No live eligibility credential for this wallet. Kestrel cannot issue one. <a href="https://app.vibestarter.xyz" target="_blank" rel="noreferrer" className="underline">Get a Vibestarter credential (Starter Card signup) ↗</a>
            </p>
          )}
          <div className="mt-3 grid gap-4 lg:grid-cols-2 max-[601px]:gap-3">
            <div className="border-t border-hair pt-3">
              <p className="text-[13px] text-ink">Raise a challenge</p>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} placeholder="Why should this tranche be withheld? (plain text, stored on-chain, max 1000 chars)" className="mt-2 w-full rounded-[2px] border border-hair-strong bg-transparent p-2 text-[12px] text-ink placeholder:text-ink-meta focus:border-phosphor/60 focus:outline-none" />
              <p className="mono text-[11px] text-ink-meta">{reason.length}/1000 · bundle: {calls.raise.map((c) => c.functionName).join(" → ")}</p>
              <label className="mt-2 flex items-start gap-2 text-[11px] text-crit">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
                <span>
                  I understand the bond of {r.next ? `${fmtUnits(r.next.bond, r.token.decimals, 0)} ${r.token.symbol}` : "—"} is locked in the escrow, and if the admin (a single EOA) rejects my challenge, 20% ({r.next ? `${fmtUnits(r.next.slashAtRisk, r.token.decimals, 0)} ${r.token.symbol}` : "—"}) is burned permanently. Kestrel does not adjudicate or recommend challenging.
                </span>
              </label>
              <ActButtons k="raise" st={st.raise} verdict={w?.canRaise} disabled={disabledAll || !reason.trim()} signDisabled={!ack} atomicLabel={calls.raise.length > 1 ? (atomic ? "SIGN 1 ATOMIC BUNDLE" : `SIGN ${calls.raise.length} TXS`) : "SIGN"} onSim={() => simulate("raise")} onSign={() => sign("raise")} chainId={r.chainId} />
              {batchId && <p className="mt-1 mono text-[11px] text-ink-2">bundle {shortAddr(batchId, 6)} · {batch.data?.status ?? "pending…"}</p>}
            </div>
            <div className="border-t border-hair pt-3">
              <p className="text-[13px] text-ink">Support / oppose the pending challenge</p>
              <input value={ctx} onChange={(e) => setCtx(e.target.value)} maxLength={1000} placeholder="Optional context (plain text, emitted on-chain)" className="mt-2 w-full rounded-[2px] border border-hair-strong bg-transparent p-2 text-[12px] text-ink placeholder:text-ink-meta focus:border-phosphor/60 focus:outline-none" />
              <p className="mt-1 mono text-[11px] text-ink-meta">Votes are evidence for the admin; the contract does not count them.</p>
              <div className="mt-2 grid gap-2">
                <ActButtons k="support" st={st.support} verdict={w?.canSupport} disabled={disabledAll} label="Support" onSim={() => simulate("support")} onSign={() => sign("support")} chainId={r.chainId} />
                <ActButtons k="oppose" st={st.oppose} verdict={w?.canOppose} disabled={disabledAll} label="Oppose" onSim={() => simulate("oppose")} onSign={() => sign("oppose")} chainId={r.chainId} />
              </div>
            </div>
          </div>
        </>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-3 max-[601px]:gap-3">
        <div className="border-t border-hair pt-3">
          <p className="text-[13px] text-ink">Expire a stale challenge</p>
          <p className="mt-1 text-[11px] text-ink-meta">Permissionless after the {Math.round(r.constants.adjudicationWindow / 3600)}h adjudication window: full bond back to the challenger, no slash.</p>
          <ActButtons k="expire" st={st.expire} verdict={w?.canExpire} disabled={!isConnected || !address} onSim={() => simulate("expire")} onSign={() => sign("expire")} chainId={r.chainId} />
        </div>
        <div className="border-t border-hair pt-3">
          <p className="text-[13px] text-ink">Claim contributor refund</p>
          <p className="mt-1 text-[11px] text-ink-meta">Failed raises only: returns the ETH you contributed.</p>
          <ActButtons k="refund" st={st.refund} verdict={w?.canClaimRefund} disabled={!isConnected || !address} onSim={() => simulate("refund")} onSign={() => sign("refund")} chainId={r.chainId} />
        </div>
        <div className="border-t border-hair pt-3">
          <p className="text-[13px] text-ink">Claim backer tokens</p>
          <p className="mt-1 text-[11px] text-ink-meta">Launch router claimTokens({r.token.symbol}) for backers who have not claimed yet.</p>
          <ActButtons k="claim" st={st.claim} verdict={w?.canClaimTokens} disabled={!isConnected || !address} onSim={() => simulate("claim")} onSign={() => sign("claim")} chainId={r.chainId} />
        </div>
      </div>
      {!isConnected && <p className="mt-3 mono text-[11px] text-ink-meta">Connect a wallet above to simulate. Every Sign button stays disabled until its simulation passes.</p>}
    </div>
  );
}

function ActButtons({
  st,
  verdict,
  disabled,
  signDisabled,
  label,
  atomicLabel,
  onSim,
  onSign,
  chainId,
}: {
  k: ActKey;
  st: ActState;
  verdict?: Verdict;
  disabled: boolean;
  signDisabled?: boolean;
  label?: string;
  atomicLabel?: string;
  onSim: () => void;
  onSign: () => void;
  chainId: number;
}) {
  const canSign = st.sim === "ok" && !signDisabled && st.tx !== "signing" && st.tx !== "sent";
  return (
    <div className="mt-2">
      {verdict && !verdict.ok && <p className="mb-1 mono text-[11px] text-ink-meta">predicted: {verdict.predictedRevert ? `${verdict.predictedRevert} — ` : ""}{verdict.reason}</p>}
      <div className="flex flex-wrap items-center gap-2 max-[601px]:grid max-[601px]:grid-cols-1">
        <button onClick={onSim} disabled={disabled || st.sim === "pending"} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink hover:border-phosphor/60 hover:text-phosphor disabled:cursor-not-allowed disabled:opacity-30 max-[901px]:min-h-[44px]">
          {st.sim === "pending" ? "simulating…" : `1 · SIMULATE${label ? ` ${label.toUpperCase()}` : ""}`}
        </button>
        <button onClick={onSign} disabled={!canSign} className="rounded-[2px] bg-crit px-3 py-1.5 mono text-[11px] font-semibold text-white hover:bg-[#ff6668] disabled:cursor-not-allowed disabled:opacity-30 max-[901px]:min-h-[44px]">
          2 · {atomicLabel ?? `SIGN${label ? ` ${label.toUpperCase()}` : ""}`}
        </button>
      </div>
      {st.sim !== "idle" && st.sim !== "pending" && (
        <p className={cx("mt-1 break-words mono text-[11px]", st.sim === "ok" ? "text-phosphor" : "text-crit")}>
          sim: {st.simMsg}
          {st.gas && st.gas.length > 0 && ` · gas ${st.gas.map((g) => Number(g).toLocaleString("en-US")).join(" + ")}`}
        </p>
      )}
      {st.tx !== "idle" && (
        <p className={cx("mt-1 break-words mono text-[11px]", st.tx === "confirmed" ? "text-phosphor" : st.tx === "failed" ? "text-crit" : "text-warn")}>
          tx: {st.tx}
          {st.hashes?.map((h) => (
            <span key={h}> · <TxLink chainId={chainId} hash={h} /></span>
          ))}
          {st.txMsg && ` · ${st.txMsg}`}
        </p>
      )}
    </div>
  );
}

/* ──────────────────────────────── rules & trust ──────────────────────────────── */

function RulesAndTrust({ r }: { r: CopilotReport }) {
  const k = r.constants;
  const rules: [string, ReactNode][] = [
    ["Challenge window", `${k.challengeWindow / 3600}h after the founder calls requestTranche`],
    ["Bond", "0.25% of supply (T1-T2), 0.50% (T3-T4), 1.00% (T5-T6); pulled with transferFrom"],
    ["Slash if rejected", `${k.slashBps / 100}% of the bond burned to 0xdead`],
    ["If upheld", "bond returned, raise Frozen, pro-rata ETH refunds via merkle root"],
    ["Unruled", `anyone may expire after ${k.adjudicationWindow / 3600}h: full bond back`],
    ["Cooldown", `${k.cooldown / 86400} days per challenger`],
    ["Votes", "recorded per wallet, not weighted or tallied on-chain"],
  ];
  const trust: DataRow[] = [
    {
      label: "Adjudicator",
      value: r.admin ? <AddrLink chainId={r.chainId} address={r.admin} className="text-[14px]" /> : "unavailable",
      sub: r.adminIsContract === false ? "EOA · one key upholds/rejects" : r.adminSafe ? `Safe ${r.adminSafe.threshold}-of-${r.adminSafe.owners.length}` : r.adminIsContract ? "contract" : undefined,
      tone: r.adminIsContract === false ? "warn" : undefined,
    },
    ...(r.trust.platformSafe
      ? [{ label: "Platform wallet", value: <AddrLink chainId={8453} address={r.trust.platformSafe.address} className="text-[14px]" />, sub: `Safe ${r.trust.platformSafe.threshold ?? "?"}-of-${r.trust.platformSafe.owners.length}` }]
      : []),
    { label: r.gen === "v1" ? "Terms signer" : "Credential attestor", value: <AddrLink chainId={r.chainId} address={r.trust.termsSigner ?? r.wallet?.credential?.attestor ?? r.trust.backendSigner} className="text-[14px]" />, sub: "single EOA" },
    { label: "Time oracle", value: k.timeOracle == null ? "unavailable" : k.timeOracle === "0x0000000000000000000000000000000000000000" ? "none (block.timestamp)" : <AddrLink chainId={r.chainId} address={k.timeOracle} className="text-[14px]" /> },
    { label: "Platform fee", value: k.platformFeeBps == null ? "unavailable" : `${(k.platformFeeBps / 100).toFixed(2)}% per tranche` },
    {
      label: "Escrow ETH",
      value: eth(r.escrowEth.balance),
      sub: r.escrowEth.pendingPlatformFees && BigInt(r.escrowEth.pendingPlatformFees) > 0n ? `${eth(r.escrowEth.pendingPlatformFees)} pending fees` : undefined,
    },
  ];
  return (
    <details className="group border-t border-hair pt-1">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-[13px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block mono transition-transform group-open:rotate-90">›</span>
        Rules &amp; trust surface · read live from the escrow
      </summary>
      <div className="grid gap-x-8 gap-y-6 pb-2 pt-3 md:grid-cols-2">
        <div className="min-w-0">
          <p className="t-kicker">Rules</p>
          <dl className="mt-2 divide-y divide-hair text-[13px] [overflow-wrap:anywhere]">
            {rules.map(([dt, dd]) => (
              <div key={dt} className="grid grid-cols-[128px_minmax(0,1fr)] gap-x-4 py-2 max-[601px]:grid-cols-1 max-[601px]:gap-y-0.5">
                <dt className="text-ink-2">{dt}</dt>
                <dd className="text-ink">{dd}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[13px] text-ink-2">
            Docs:{" "}
            <a className="ink-link hover:text-ink" href="https://app.vibestarter.xyz/docs/tranches" target="_blank" rel="noreferrer">/docs/tranches ↗</a> ·{" "}
            <a className="ink-link hover:text-ink" href="https://app.vibestarter.xyz/docs/escrow" target="_blank" rel="noreferrer">/docs/escrow ↗</a> ·{" "}
            <a className="ink-link hover:text-ink" href={r.vibestarterUrl} target="_blank" rel="noreferrer">raise page ↗</a>
          </p>
        </div>
        <div className="min-w-0">
          <p className="t-kicker">Trust surface · facts only</p>
          <DataList rows={trust} dense className="mt-2" />
        </div>
      </div>
    </details>
  );
}
