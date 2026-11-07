import { formatUnits } from "viem";
import { Panel, Stat } from "@/components/ui";
import { cached } from "@/lib/cache";
import { errMsg } from "@/lib/engine/chain-utils";
import { type RevenueReport, x402RevenueReport } from "@/lib/engine/x402-revenue";
import { fmtUnits, shortAddr } from "@/lib/format";
import { x402Config } from "@/lib/x402";

/**
 * Server component: live onchain x402 revenue ledger (Base USDC Transfer logs into the receiver).
 * Shares the 60 s cache key with GET /api/x402/revenue. Honest empty / unavailable states, never placeholder numbers.
 */
export async function X402RevenuePanel() {
  const cfg = x402Config();
  let report: RevenueReport | null = null;
  let error: string | null = null;
  try {
    report = cfg.receiver
      ? await cached(`x402:revenue:report:${cfg.receiver.toLowerCase()}:${process.env.X402_LEDGER_FROM_BLOCK ?? "auto"}`, 60, x402RevenueReport)
      : await x402RevenueReport();
  } catch (e) {
    error = errMsg(e);
  }

  const right = (
    <a href="/api/x402/revenue" className="mono text-[11px] text-phosphor hover:underline max-[901px]:inline-flex max-[901px]:min-h-9 max-[901px]:items-center max-[901px]:gap-1">
      JSON ↗
    </a>
  );

  if (error || !report) {
    return (
      <Panel variant="instrument" title="LIVE // x402 REVENUE · BASE USDC" right={right} className="min-w-0 [&_.label]:!text-ink-meta">
        <p className="mono text-[12px] text-warn">Revenue scan unavailable right now ({error ?? "no data"}). Nothing is shown rather than a guess; retry in a minute.</p>
      </Panel>
    );
  }

  if (!report.configured) {
    return (
      <Panel variant="instrument" title="LIVE // x402 REVENUE · BASE USDC" right={right} className="min-w-0 [&_.label]:!text-ink-meta">
        <p className="text-[13px] leading-relaxed text-ink-2">
          No receiver is configured on this deployment, so it has not taken any x402 payments and there is no revenue to show. Once{" "}
          <span className="mono text-ink">X402_RECEIVER_ADDRESS</span> is set, this panel sums every Base USDC <span className="mono">Transfer</span> into it, straight from{" "}
          <span className="mono">eth_getLogs</span> in 50,000-block windows, and labels each settlement by its EIP-3009 <span className="mono">AuthorizationUsed</span> event.
        </p>
      </Panel>
    );
  }

  const r = report;
  return (
    <Panel variant="instrument" title="LIVE // x402 REVENUE · BASE USDC" right={right} className="min-w-0 [&_.label]:!text-ink-meta">
      <div className="grid grid-cols-2 gap-y-5 md:grid-cols-4 md:divide-x md:divide-hair [&>*]:[overflow-wrap:anywhere] md:[&>*]:px-4 md:[&>*:first-child]:pl-0">
        <Stat label="USDC received" value={fmtUnits(r.totalAtomic, 6, 6)} tone="phosphor" sub={`${r.totalAtomic} atomic`} />
        <Stat label="Transfers in" value={r.transfers.toLocaleString("en-US")} sub={`price ${formatUnits(BigInt(r.priceAtomic), 6)} USDC / call`} />
        <Stat label="Unique payers" value={r.uniquePayers.toLocaleString("en-US")} />
        <Stat label="Server ledger" value={r.ledger.settlementsRecorded === null ? "n/a" : r.ledger.settlementsRecorded.toLocaleString("en-US")} sub="settlements delivered" />
      </div>
      <p className="mt-5 border-t border-hair pt-3 mono text-[12px] leading-relaxed text-ink-meta [overflow-wrap:anywhere]">
        Receiver{" "}
        <a href={r.explorer} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-white/10 underline-offset-2 hover:text-ink">
          {shortAddr(r.receiver, 6)} ↗
        </a>{" "}
        · Base blocks {Number(r.fromBlock).toLocaleString("en-US")} → {Number(r.scannedTo).toLocaleString("en-US")} ({r.fromBlockSource === "env" ? "from X402_LEDGER_FROM_BLOCK" : "auto: ~24 h before first scan"}) · head{" "}
        {Number(r.headBlock).toLocaleString("en-US")}
        {r.catchingUp ? " · catching up, more history on the next refresh" : ""}
      </p>
      {r.scanError && <p className="mt-2 mono text-[11px] text-warn">Partial scan: {r.scanError}</p>}
      {r.recent.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-2">No USDC has reached the receiver in the scanned range yet. The first settled x402 call will show up here with its Basescan link.</p>
      ) : (
        <div className="mt-4 max-w-full overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[520px] mono text-[12px]">
            <thead>
              <tr className="text-left text-ink-meta">
                <th className="py-1 pr-3 font-normal">tx</th>
                <th className="py-1 pr-3 font-normal">block</th>
                <th className="py-1 pr-3 font-normal">payer</th>
                <th className="py-1 pr-3 text-right font-normal">USDC</th>
                <th className="py-1 font-normal">kind</th>
              </tr>
            </thead>
            <tbody>
              {r.recent.map((row) => (
                <tr key={row.tx} className="border-t hairline">
                  <td className="py-1.5 pr-3">
                    <a href={row.explorer} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-white/10 underline-offset-2 hover:text-ink">
                      {shortAddr(row.tx, 6)} ↗
                    </a>
                  </td>
                  <td className="py-1.5 pr-3 tnum text-ink-meta">{row.block}</td>
                  <td className="py-1.5 pr-3 text-ink-2">{shortAddr(row.payer, 4)}</td>
                  <td className="py-1.5 pr-3 text-right tnum text-ink">{formatUnits(BigInt(row.amountAtomic), 6)}</td>
                  <td className="py-1.5 text-ink-meta">{row.viaEip3009 === null ? "receipt n/a" : row.viaEip3009 ? `x402 / EIP-3009 · via ${shortAddr(row.submittedBy, 4)}` : "plain transfer"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
