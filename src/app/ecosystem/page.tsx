import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { Suspense } from "react";
import { InkLink, Kicker, Rule, SkeletonRows, Wrap } from "@/components/editorial";
import { EcosystemTable } from "@/components/ecosystem-table";
import { rv } from "@/components/motion";
import { PageMasthead } from "@/components/page-masthead";
import { AddrLink, Stat } from "@/components/ui";
import { explorerBlock, fmtUnits } from "@/lib/format";
import { getEcosystemBoard } from "@/lib/vibestarter/ecosystem";

export const revalidate = 120;
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Vibestarter Ecosystem Health Board — every launch on Base & Robinhood Chain, live",
  description:
    "Live health of every Vibestarter launch on Base and Robinhood Chain: token bytecode X-Ray score, on-chain Proof-of-Lock, pool depth, tranche escrow state and next challenge window, Refund Radar, founder app uptime, founder GitHub velocity and Origin Capsule status.",
  alternates: { canonical: "/ecosystem" },
};

const CHECKS: { title: string; body: string }[] = [
  { title: "Token X-Ray score", body: "eth_getCode + EIP-1967 slots on the launch token: mint / blacklist / pause / tax selectors, mutable proxies, EOA vs Safe controllers, plus exit depth. 0–100, same deterministic rules as the main scanner." },
  { title: "Proof-of-Lock", body: "VibesLPLockerV2.verifyLPLocked() and the pool's LP totalSupply: the share of pool liquidity soulbound in an immutable EIP-1167 fee-claimer clone, which nobody can ever withdraw. The lock transaction receipt is verified as well." },
  { title: "Pool depth", body: "WETH actually held by the launch's pool (balanceOf at the read block): how much a backer could exit into right now." },
  { title: "Escrow state & next window", body: "Live VibesTranchEscrow reads: state, tranches paid out of seven, ETH still escrowed, and a countdown to the next unlock, 72-hour challenge window or refund deadline." },
  { title: "Refund Radar", body: "For failed or refunding raises: the ETH still claimable by contributors or token holders, the share already redeemed, and when the admin may sweep what is left." },
  { title: "Founder app & GitHub", body: "A live HTTP probe of the app the founder shipped, plus public GitHub pushes and commits over 30 days and whether the Origin Capsule repo still exists." },
  { title: "Origin Capsule", body: "Whether the token is registered in that chain's VibesRegistry (AI-provenance capsule hash), and the provenance tier Vibestarter publishes for it." },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function Board() {
  const board = await getEcosystemBoard({ onBackgroundRefresh: (p) => after(p) }).catch(() => null);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!board || board.rows.length === 0) {
    return (
      <section className="border-l-2 border-warn pl-6">
        <Kicker tone="warn">Board unavailable</Kicker>
        <p className="mt-3 max-w-[66ch] text-[15px] leading-relaxed text-ink">
          Kestrel could not enumerate Vibestarter launches right now
          {board?.universe.error ? ` (${board.universe.error})` : ""}. Factory, REST and MCP reads all failed or timed out, so nothing is shown rather than stale or invented
          figures. Try again in a minute, or query <a className="mono text-phosphor underline" href="/api/ecosystem">/api/ecosystem</a>.
        </p>
      </section>
    );
  }
  const t = board.totals;
  const raisedBase = t.raisedWeiByChain["8453"] ?? null;
  const raisedRh = t.raisedWeiByChain["4663"] ?? null;
  const refunding = board.rows.filter((r) => /refund/i.test(r.escrowState?.stateLabel ?? "")).length;
  const windows = t.pendingChallenges > 0 ? plural(t.pendingChallenges, "challenge awaiting ruling", "challenges awaiting ruling") : `${plural(t.openWindows, "challenge window")} open`;
  return (
    <div>
      {/* Lead line: every count is from this board read. No data-rv inside this streamed boundary: the observer can tag it before hydration. */}
      <p className="max-w-[48ch] font-serif text-[28px] leading-[1.25] text-ink [text-wrap:balance] max-[601px]:text-[24px]">
        {plural(t.launches, "launch", "launches")} across Base and Robinhood Chain; {refunding} refunding; {windows}.
      </p>

      <section aria-label="Ecosystem totals" className="mt-10 grid grid-cols-2 gap-y-6 border-y border-hair py-6 md:grid-cols-3 lg:grid-cols-6 lg:divide-x lg:divide-hair [&>*]:[overflow-wrap:anywhere] lg:[&>*]:px-5 lg:[&>*:first-child]:pl-0 max-[1023px]:[&>*]:pr-4">
        <Stat label="Launches" value={t.launches} sub={`${t.byChain["8453"] ?? 0} Base · ${t.byChain["4663"] ?? 0} Robinhood`} />
        <Stat label="Raised (onchain)" value={raisedBase ? `${fmtUnits(raisedBase, 18, 2)} ETH` : "—"} sub={raisedRh ? `+ ${fmtUnits(raisedRh, 18, 3)} ETH on Robinhood` : "Base escrows"} tone="base" />
        <Stat label="Still in escrow" value={`${fmtUnits(t.inEscrowWei, 18, 2)} ETH`} sub={`${t.escrowsRead}/${t.launches} escrows read`} />
        <Stat label="LP ETH soulbound" value={`${fmtUnits(t.lpEthLockedWei, 18, 3)} ETH`} sub={plural(t.lockedPositions, "verified lock")} tone="phosphor" />
        <Stat
          label="Challenge windows"
          value={t.pendingChallenges > 0 ? `${t.pendingChallenges} pending` : `${t.openWindows} open`}
          sub={t.pendingChallenges > 0 ? "challenge awaiting ruling" : t.openWindows > 0 ? "backers can challenge now" : "none open right now"}
          tone={t.pendingChallenges > 0 ? "crit" : t.openWindows > 0 ? "warn" : undefined}
        />
        <Stat label="Founder apps up" value={`${t.appsUp}/${t.appsProbed}`} sub={BigInt(t.refundsUnclaimedWei) > 0n ? `${fmtUnits(t.refundsUnclaimedWei, 18, 3)} ETH refunds unclaimed` : "live HTTP probes"} tone={t.appsUp === t.appsProbed ? "phosphor" : "warn"} />
      </section>

      <div className="mt-12 min-w-0">
        <EcosystemTable rows={board.rows} nowSec={nowSec} />
      </div>

      <section aria-label="Data provenance" className="mt-16 grid gap-x-10 gap-y-10 text-[13px] leading-relaxed text-ink-2 md:grid-cols-2 [&>*]:min-w-0 [&>*]:[overflow-wrap:anywhere]">
        <div className="border-t border-hair-strong pt-4">
          <Kicker>How the launch list was built</Kicker>
          <ul className="mt-4 divide-y divide-hair">
            {board.universe.factories.map((f) => (
              <li key={`${f.chainId}:${f.address}`} className="flex flex-wrap items-center gap-x-3 py-2">
                <AddrLink chainId={f.chainId} address={f.address} label={f.label} className="text-[12px] max-[901px]:inline-flex max-[901px]:min-h-9 max-[901px]:items-center max-[901px]:gap-1" />
                <span className="mono text-[12px] text-ink-meta">getAllEscrows · totalEscrows = {f.totalEscrows ?? "unreadable"}</span>
              </li>
            ))}
            <li className="py-2">
              Vibestarter REST <span className="mono">/api/campaigns</span>: {board.universe.restCount ?? "unavailable"} raises · Vibestarter MCP <span className="mono">list_raises</span>:{" "}
              {board.universe.mcp.ok ? `${board.universe.mcp.raises} raises (it omits refunding raises)` : "unavailable"}
            </li>
          </ul>
        </div>
        <div className="border-t border-hair-strong pt-4">
          <Kicker>Freshness</Kicker>
          <ul className="mt-4 divide-y divide-hair">
            {Object.entries(board.blocks).map(([chain, n]) => (
              <li key={chain} className="py-2">
                {chain === "4663" ? "Robinhood Chain" : "Base"} escrow reads at block{" "}
                <a href={explorerBlock(Number(chain), n)} target="_blank" rel="noreferrer" className="mono tnum text-ink underline decoration-white/10 underline-offset-2 hover:text-phosphor max-[901px]:inline-flex max-[901px]:min-h-9 max-[901px]:items-center max-[901px]:gap-1">
                  {Number(n).toLocaleString("en-US")} <span className="text-ink-3">↗</span>
                </a>
              </li>
            ))}
            <li className="py-2">
              Board assembled <span className="mono">{board.fetchedAt.replace("T", " ").slice(0, 19)} UTC</span> in {(board.buildMs / 1000).toFixed(1)} s
              {board.cache?.stale ? " · serving the previous copy while a refresh runs" : ""}.
            </li>
            <li className="py-2">
              Machine-readable: <a href="/api/ecosystem" className="mono text-phosphor underline decoration-phosphor/30 underline-offset-2 max-[901px]:inline-flex max-[901px]:min-h-9 max-[901px]:items-center max-[901px]:gap-1">GET /api/ecosystem</a>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}

export default function EcosystemPage() {
  return (
    <div className="min-w-0">
      <PageMasthead
        kicker="Vibestarter ecosystem health board"
        title={["Every Vibestarter launch,", "checked live onchain."]}
        dek="Tranche escrows, LP locks, pools, founder apps and challenge windows, read straight from the contracts on Base and Robinhood Chain."
        meta={
          <>
            <span>No wallet needed</span>
            <span className="text-ink-3">·</span>
            <span>120 s cache</span>
            <span className="text-ink-3">·</span>
            <span>Not financial advice</span>
          </>
        }
      />

      <Wrap className="pt-12 max-[901px]:pt-8">
        <div className="min-w-0">
          <Suspense fallback={<SkeletonRows rows={6} heights={[56, 44, 44, 44, 44, 44]} caption="Reading every Vibestarter factory, escrow, LP locker and pool on Base and Robinhood Chain" />}>
            <Board />
          </Suspense>
        </div>

        <section aria-labelledby="checks-h" className="mt-20 max-[901px]:mt-14">
          <Rule strong />
          <div className="grid gap-x-10 gap-y-6 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="min-w-0">
              <Kicker tone="phosphor">Method</Kicker>
              <h2 id="checks-h" className="mt-4 font-serif text-[40px] leading-[1.05] text-ink [text-wrap:balance] max-[601px]:text-[32px]">
                What the board checks
              </h2>
              <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-ink-2">
                $VIBES is the platform token, so its value depends on how healthy the raises built on Vibestarter are. A drained pool, a dead founder app or an unwatched
                challenge window hurts every backer. If a read fails, the cell says &quot;unavailable&quot;. Kestrel never fills in a number.
              </p>
            </div>
            <dl className="divide-y divide-hair border-y border-hair">
              {CHECKS.map((c, i) => (
                <div key={c.title} {...rv(i)} className="grid gap-x-8 gap-y-1 py-4 md:grid-cols-[minmax(0,16ch)_minmax(0,1fr)]">
                  <dt className="text-[15px] font-medium text-ink">{c.title}</dt>
                  <dd className="text-[14px] leading-relaxed text-ink-2">{c.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <div {...rv(0)} className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-3 max-[601px]:[&>a:first-child]:w-full">
          <Link href="/app?tab=shield" className="btn-primary press">
            OPEN BACKER SHIELD
          </Link>
          <InkLink href="/how-it-works#shield">How the checks work</InkLink>
          <InkLink href="/agents#mcp">Agents · MCP · x402</InkLink>
        </div>
      </Wrap>
    </div>
  );
}
