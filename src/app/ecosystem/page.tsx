import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { Suspense } from "react";
import { EcosystemTable } from "@/components/ecosystem-table";
import { AddrLink, Panel, SectionLabel, Stat } from "@/components/ui";
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

function BoardSkeleton() {
  return (
    <div className="panel p-6" aria-busy="true">
      <p className="mono text-[12px] text-phosphor cursor-blink">Reading every Vibestarter factory, escrow, LP locker and pool on Base and Robinhood Chain</p>
      <p className="mt-2 text-[13px] text-ink-3">
        The first read takes a few seconds on public RPCs. After that the board is served from a 120-second cache. No numbers are shown until the reads finish.
      </p>
      <div className="mt-6 space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-14 w-full animate-pulse bg-white/[0.03]" />
        ))}
      </div>
    </div>
  );
}

async function Board() {
  const board = await getEcosystemBoard({ onBackgroundRefresh: (p) => after(p) }).catch(() => null);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!board || board.rows.length === 0) {
    return (
      <Panel title="Board unavailable" n="!">
        <p className="text-[14px] text-ink-2">
          Kestrel could not enumerate Vibestarter launches right now
          {board?.universe.error ? ` (${board.universe.error})` : ""}. Factory, REST and MCP reads all failed or timed out, so nothing is shown rather than stale
          or invented figures. Try again in a minute, or query <a className="mono text-phosphor underline" href="/api/ecosystem">/api/ecosystem</a>.
        </p>
      </Panel>
    );
  }
  const t = board.totals;
  const raisedBase = t.raisedWeiByChain["8453"] ?? null;
  const raisedRh = t.raisedWeiByChain["4663"] ?? null;
  return (
    <div className="space-y-6">
      <section aria-label="Ecosystem totals" className="panel grid grid-cols-2 gap-x-6 gap-y-5 p-5 max-[600px]:gap-x-4 max-[600px]:p-4 md:grid-cols-3 lg:grid-cols-6 [&>*]:[overflow-wrap:anywhere]">
        <Stat label="Launches" value={t.launches} sub={`${t.byChain["8453"] ?? 0} Base · ${t.byChain["4663"] ?? 0} Robinhood`} />
        <Stat label="Raised (on-chain)" value={raisedBase ? `${fmtUnits(raisedBase, 18, 2)} ETH` : "—"} sub={raisedRh ? `+ ${fmtUnits(raisedRh, 18, 3)} ETH on Robinhood` : "Base escrows"} tone="base" />
        <Stat label="Still in escrow" value={`${fmtUnits(t.inEscrowWei, 18, 2)} ETH`} sub={`${t.escrowsRead}/${t.launches} escrows read`} />
        <Stat label="LP ETH soulbound" value={`${fmtUnits(t.lpEthLockedWei, 18, 3)} ETH`} sub={`${t.lockedPositions} verified lock${t.lockedPositions === 1 ? "" : "s"}`} tone="phosphor" />
        <Stat
          label="Challenge windows"
          value={t.pendingChallenges > 0 ? `${t.pendingChallenges} pending` : `${t.openWindows} open`}
          sub={t.pendingChallenges > 0 ? "challenge awaiting ruling" : t.openWindows > 0 ? "backers can challenge now" : "none open right now"}
          tone={t.pendingChallenges > 0 ? "crit" : t.openWindows > 0 ? "warn" : undefined}
        />
        <Stat label="Founder apps up" value={`${t.appsUp}/${t.appsProbed}`} sub={BigInt(t.refundsUnclaimedWei) > 0n ? `${fmtUnits(t.refundsUnclaimedWei, 18, 3)} ETH refunds unclaimed` : "live HTTP probes"} tone={t.appsUp === t.appsProbed ? "phosphor" : "warn"} />
      </section>

      <EcosystemTable rows={board.rows} nowSec={nowSec} />

      <section aria-label="Data provenance" className="grid gap-4 text-[12px] text-ink-3 md:grid-cols-2 [&>*]:min-w-0 [&>*]:[overflow-wrap:anywhere]">
        <div className="panel p-4">
          <p className="label mb-2">How the launch list was built</p>
          <ul className="space-y-1.5">
            {board.universe.factories.map((f) => (
              <li key={`${f.chainId}:${f.address}`} className="flex flex-wrap items-center gap-x-2">
                <AddrLink chainId={f.chainId} address={f.address} label={f.label} className="text-[12px]" />
                <span className="mono">getAllEscrows · totalEscrows = {f.totalEscrows ?? "unreadable"}</span>
              </li>
            ))}
            <li>
              Vibestarter REST <span className="mono">/api/campaigns</span>: {board.universe.restCount ?? "unavailable"} raises · Vibestarter MCP{" "}
              <span className="mono">list_raises</span>: {board.universe.mcp.ok ? `${board.universe.mcp.raises} raises (it omits refunding raises)` : "unavailable"}
            </li>
          </ul>
        </div>
        <div className="panel p-4">
          <p className="label mb-2">Freshness</p>
          <ul className="space-y-1.5">
            {Object.entries(board.blocks).map(([chain, n]) => (
              <li key={chain}>
                {chain === "4663" ? "Robinhood Chain" : "Base"} escrow reads at block{" "}
                <a href={explorerBlock(Number(chain), n)} target="_blank" rel="noreferrer" className="mono text-ink-2 underline decoration-white/10 underline-offset-2 hover:text-ink">
                  {Number(n).toLocaleString("en-US")} ↗
                </a>
              </li>
            ))}
            <li>
              Board assembled <span className="mono">{board.fetchedAt.replace("T", " ").slice(0, 19)} UTC</span> in {(board.buildMs / 1000).toFixed(1)} s
              {board.cache?.stale ? " · serving the previous copy while a refresh runs" : ""}.
            </li>
            <li>
              Machine-readable: <a href="/api/ecosystem" className="mono text-phosphor underline decoration-phosphor/30 underline-offset-2">GET /api/ecosystem</a>
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}

export default function EcosystemPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-12 max-[900px]:pt-8">
      <SectionLabel n="05">Vibestarter Ecosystem Health Board</SectionLabel>
      <h1 className="mt-4 max-w-4xl font-serif text-[40px] leading-[1.05] text-ink max-[600px]:text-[34px] md:text-[52px]">Every Vibestarter launch, checked live on-chain.</h1>
      <div className="mt-5 grid gap-8 max-[900px]:gap-6 lg:grid-cols-[1.2fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4 text-[15px] leading-relaxed text-ink-2 max-[600px]:text-[14px]">
          <p>
            Vibestarter raises sit in tranche escrows: a 10% kickstart, then six monthly 15% releases. Each release opens a 72-hour window where token holders
            can challenge it. Liquidity is meant to be locked for good. This board reads every launch on Base and Robinhood Chain straight from the contracts
            and puts the checks a backer would otherwise run by hand in one table.
          </p>
          <p>
            <strong className="font-medium text-ink">Why it matters to $VIBES backers:</strong> $VIBES is the platform token, so its value depends on how
            healthy the raises built on Vibestarter are. A drained pool, a dead founder app or an unwatched challenge window hurts the whole ecosystem. Here you
            can see those risks before a window closes, without connecting a wallet.
          </p>
          <p className="text-[13px] text-ink-3">
            Every figure comes from a live RPC read, Vibestarter&apos;s public REST API or MCP server, GitHub&apos;s public API or an HTTP probe, and links to an
            explorer. If a read fails, the cell says &quot;unavailable&quot;. Kestrel never fills in a number. Not financial advice.
          </p>
        </div>
        <Panel title="What the board checks">
          <ul className="space-y-3">
            {CHECKS.map((c) => (
              <li key={c.title}>
                <p className="mono text-[12px] text-phosphor">{c.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{c.body}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="mt-10 min-w-0 max-[900px]:mt-8">
        <Suspense fallback={<BoardSkeleton />}>
          <Board />
        </Suspense>
      </div>

      <div className="mt-10 flex flex-wrap gap-3 max-[900px]:mt-8">
        <Link href="/app?tab=shield" className="rounded-[2px] bg-phosphor px-4 py-2.5 mono text-[12px] font-semibold text-canvas hover:bg-[#a6e698] max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">
          OPEN BACKER SHIELD →
        </Link>
        <Link href="/how-it-works" className="rounded-[2px] border border-hair-strong px-4 py-2.5 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">
          How the checks work
        </Link>
        <Link href="/agents" className="rounded-[2px] border border-hair-strong px-4 py-2.5 mono text-[12px] text-ink hover:border-phosphor/60 hover:text-phosphor max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">
          Agents · MCP · x402
        </Link>
      </div>
    </div>
  );
}
