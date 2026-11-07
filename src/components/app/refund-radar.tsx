"use client";

import { type ReactNode, useEffect, useState } from "react";
import { type Address, BaseError, ContractFunctionRevertedError, getAddress } from "viem";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { cx, TxLink } from "@/components/ui";
import { fmtUnits, fmtUtc } from "@/lib/format";
import type { EscrowReport } from "@/lib/engine/types";
import { VS_ESCROW_EXTRA_ABI } from "@/lib/vibestarter/abis";

const REVERT_TEXT: Record<string, string> = {
  NotAContributor: "This wallet never contributed to this raise.",
  AlreadyClaimed: "This wallet already claimed its refund.",
  InvalidState: "The escrow is not in the Failed state, so contributor refunds are not open.",
  EthTransferFailed: "The escrow could not send ETH to this wallet (contract wallet rejected it).",
};

function decodeErr(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) return REVERT_TEXT[rev.data.errorName] ?? `Reverted: ${rev.data.errorName}`;
    return (e.shortMessage || e.message).split("\n")[0].slice(0, 200);
  }
  return e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
}

const FIG_TONE = { phosphor: "text-phosphor", warn: "text-warn", crit: "text-crit" } as const;

/** Unboxed figure, split from its neighbours by whitespace only (PAPER: no borders, no fills). */
function Fig({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: keyof typeof FIG_TONE }) {
  return (
    <div className="min-w-0">
      <p className="t-kicker">{label}</p>
      <p className={cx("mt-2 tnum text-[22px] leading-tight [overflow-wrap:anywhere] max-[601px]:text-[18px]", tone ? FIG_TONE[tone] : "text-ink")}>{value}</p>
      {sub && <p className="mt-1 mono text-[12px] leading-snug text-ink-meta">{sub}</p>}
    </div>
  );
}

type WalletRefund = { contributed: bigint; refundClaimed: boolean; merkleClaimed: boolean | null };

/** Refund Radar: live refund economics for Failed / Refunding escrows + a per-wallet check and simulate-then-sign claim. */
export function RefundRadar({ e }: { e: EscrowReport }) {
  const r = e.refund;
  if (!r) return null;
  const sym = e.tokenSymbol ?? "tokens";
  const dec = e.tokenDecimals ?? 18;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Fig label="Refund mode" value={r.mode === "contributor" ? "Contributor" : "Holder (merkle)"} sub={<span className="mono">{r.claimFunction}</span>} />
        <Fig label="ETH still in escrow" value={`${fmtUnits(r.escrowBalance, 18, 4)} Ξ`} tone={r.allClaimed ? "phosphor" : "warn"} />
        {r.mode === "holder" ? (
          <>
            <Fig label="Unclaimed refunds" value={r.unclaimedEthEstimate != null ? `${fmtUnits(r.unclaimedEthEstimate, 18, 4)} Ξ` : "unavailable"} sub={r.redeemedBps != null ? `${(r.redeemedBps / 100).toFixed(2)}% of snapshot supply redeemed` : undefined} tone="warn" />
            <Fig label={`ETH per 1M ${sym}`} value={r.ethPerMillionTokens != null ? `${fmtUnits(r.ethPerMillionTokens, 18, 6)} Ξ` : "unavailable"} sub={r.frozenEthBalance != null && r.frozenTotalSupply != null ? `${fmtUnits(r.frozenEthBalance, 18, 4)} Ξ over ${fmtUnits(r.frozenTotalSupply, dec, 0)} ${sym}` : undefined} />
          </>
        ) : (
          <>
            <Fig label="Deadline" value="None" sub="Failed escrows have no sweep" />
            <Fig label="Status" value={r.allClaimed ? "All claimed" : "Open"} tone={r.allClaimed ? "phosphor" : "warn"} />
          </>
        )}
      </div>
      {r.sweepAfter && (
        <div className="border-l-2 border-warn pl-4">
          <p className="t-kicker text-warn">Holder refund window closes</p>
          <p className="mt-2 tnum text-[22px] text-warn max-[601px]:text-[18px]">{r.sweepAfter > e.oracleTime ? fmtUtc(r.sweepAfter) : "closed · sweep allowed"}</p>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-2">
            Refunding started {fmtUtc(r.refundingStartTime ?? 0)}; after {fmtUtc(r.sweepAfter)} the admin may call sweepResidualEth() and unclaimed ETH goes to the platform wallet (REFUND_SWEEP_DELAY = 180 days, read onchain).
          </p>
        </div>
      )}
      <p className="max-w-[70ch] text-[14px] leading-relaxed text-ink-2">{r.note}</p>
      <WalletRefundCheck e={e} />
    </div>
  );
}

function WalletRefundCheck({ e }: { e: EscrowReport }) {
  const r = e.refund!;
  const chainId = e.chainId;
  const escrow = getAddress(e.address) as Address;
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();
  const [w, setW] = useState<WalletRefund | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [sim, setSim] = useState<{ status: "idle" | "pending" | "ok" | "fail"; message?: string }>({ status: "idle" });
  const [tx, setTx] = useState<{ status: "idle" | "signing" | "sent" | "confirmed" | "failed"; hash?: string; message?: string }>({ status: "idle" });

  useEffect(() => {
    setW(null);
    setReadErr(null);
    setSim({ status: "idle" });
    setTx({ status: "idle" });
    if (!address || !publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const [contrib, merkle] = await publicClient.multicall({
          allowFailure: true,
          contracts: [
            { address: escrow, abi: VS_ESCROW_EXTRA_ABI, functionName: "getContribution", args: [address] },
            { address: escrow, abi: VS_ESCROW_EXTRA_ABI, functionName: "refundClaimedFromMerkle", args: [address] },
          ],
        });
        if (cancelled) return;
        const c = contrib.status === "success" ? contrib.result : null;
        setW({ contributed: c?.amount ?? 0n, refundClaimed: c?.refundClaimed ?? false, merkleClaimed: merkle.status === "success" ? merkle.result : null });
      } catch (err) {
        if (!cancelled) setReadErr(decodeErr(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, escrow]);

  const simulate = async () => {
    if (!address || !publicClient) return;
    setSim({ status: "pending" });
    try {
      await publicClient.simulateContract({ account: address, address: escrow, abi: VS_ESCROW_EXTRA_ABI, functionName: "claimContributorRefund" });
      setSim({ status: "ok", message: `Simulation passed at the latest block: claimContributorRefund() would send ${w ? fmtUnits(w.contributed, 18, 6) : "your"} Ξ to ${address.slice(0, 8)}…` });
    } catch (err) {
      setSim({ status: "fail", message: decodeErr(err) });
    }
  };

  const claim = async () => {
    if (!address || !publicClient || sim.status !== "ok") return;
    try {
      if (walletChainId !== chainId) await switchChainAsync({ chainId });
      // re-simulate immediately before signing (state may have changed)
      await publicClient.simulateContract({ account: address, address: escrow, abi: VS_ESCROW_EXTRA_ABI, functionName: "claimContributorRefund" });
      setTx({ status: "signing" });
      const hash = await writeContractAsync({ chainId, address: escrow, abi: VS_ESCROW_EXTRA_ABI, functionName: "claimContributorRefund" });
      setTx({ status: "sent", hash });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      setTx({ status: rc.status === "success" ? "confirmed" : "failed", hash, message: rc.status === "success" ? "Refund claimed." : "Transaction reverted." });
    } catch (err) {
      setTx({ status: "failed", message: decodeErr(err) });
    }
  };

  return (
    <div className="border-t border-hair pt-4">
      <p className="t-kicker">Your refund · wallet check</p>
      {!isConnected || !address ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-ink-meta">Connect a wallet to read your contribution and refund status from the escrow (read-only until you choose to sign).</span>
          {connectors.map((c) => (
            <button key={c.uid} onClick={() => connect({ connector: c, chainId })} disabled={connecting} className="rounded-[2px] border border-hair-strong min-h-[40px] px-3 py-1.5 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor disabled:opacity-40 max-[601px]:flex-1">
              {c.name}
            </button>
          ))}
        </div>
      ) : readErr ? (
        <p className="mt-2 mono text-[12px] text-crit">Wallet read failed: {readErr}</p>
      ) : !w ? (
        <p className="mt-2 mono text-[12px] text-ink-meta cursor-blink">Reading getContribution({address.slice(0, 8)}…)</p>
      ) : (
        <div className="mt-3 space-y-3 text-[12px]">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] [overflow-wrap:anywhere] gap-x-4 gap-y-1">
            <dt className="text-ink-meta">Contributed</dt>
            <dd className="tnum text-ink">{fmtUnits(w.contributed, 18, 6)} Ξ</dd>
            {r.mode === "contributor" ? (
              <>
                <dt className="text-ink-meta">Refund</dt>
                <dd className={w.refundClaimed ? "text-phosphor" : w.contributed > 0n ? "text-warn" : "text-ink-meta"}>{w.contributed === 0n ? "nothing owed — not a contributor" : w.refundClaimed ? "already claimed" : "unclaimed"}</dd>
              </>
            ) : (
              <>
                <dt className="text-ink-meta">Holder refund</dt>
                <dd className={w.merkleClaimed ? "text-phosphor" : "text-ink-2"}>{w.merkleClaimed == null ? "unavailable" : w.merkleClaimed ? "already claimed" : "not claimed yet"}</dd>
              </>
            )}
          </dl>
          {r.mode === "contributor" && w.contributed > 0n && !w.refundClaimed && (
            <div className="flex flex-wrap items-center gap-2 max-[601px]:grid max-[601px]:grid-cols-1">
              <button onClick={simulate} disabled={sim.status === "pending"} className="rounded-[2px] border border-hair-strong min-h-[40px] px-3 py-1.5 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor disabled:opacity-40 max-[901px]:min-h-[44px]">
                {sim.status === "pending" ? "simulating…" : "1 · Simulate claimContributorRefund()"}
              </button>
              <button onClick={claim} disabled={sim.status !== "ok" || tx.status === "signing" || tx.status === "sent"} className="rounded-[2px] border border-phosphor/50 px-3 py-1.5 mono text-[12px] text-phosphor hover:bg-phosphor/10 disabled:opacity-30 max-[901px]:min-h-[44px]">
                2 · Sign claim
              </button>
            </div>
          )}
          {r.mode === "holder" && (
            <p className="text-ink-meta">
              Holder refunds need a merkle proof from Vibestarter&apos;s refund tree (no public proof endpoint), so the claim runs on the raise page.{" "}
              {e.vibestarterUrl && (
                <a href={e.vibestarterUrl} target="_blank" rel="noreferrer" className="text-warn hover:underline">
                  Claim on Vibestarter ↗
                </a>
              )}
            </p>
          )}
          {sim.message && <p className={cx("mono text-[12px] [overflow-wrap:anywhere]", sim.status === "ok" ? "text-phosphor" : "text-crit")}>{sim.message}</p>}
          {tx.status !== "idle" && (
            <p className={cx("mono text-[12px]", tx.status === "failed" ? "text-crit" : tx.status === "confirmed" ? "text-phosphor" : "text-ink-2")}>
              {tx.status === "signing" ? "Confirm in your wallet…" : tx.status === "sent" ? "Sent — waiting for confirmation " : tx.message}
              {tx.hash && <TxLink chainId={e.chainId} hash={tx.hash} label=" tx ↗" />}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
