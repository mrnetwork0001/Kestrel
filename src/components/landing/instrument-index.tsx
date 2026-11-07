import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { DEMO_RESCUE_WALLET } from "@/config/demo";
import { InkLink, Kicker, Rule, Wrap } from "@/components/editorial";
import { rv, SplitWords } from "@/components/motion";
import { cx } from "@/components/ui";
import { fmtCompact } from "@/lib/format";
import { getEscrow, getGuard, getParity, getScan } from "./data";

/*
 * S3 · The Desk: an 8-row instrument index (replaces the PILLARS card grid). Each row's figure is a real value from
 * the shared cached reads, or omitted. RESCUE's figure is labelled "mechanism" (it describes how, not a reading).
 */

type Row = { key: string; verb: string; title: string; dek: string; href: string; flagship?: boolean };

const ROWS: Row[] = [
  { key: "read", verb: "READ", title: "While You Slept Briefing", dek: "A 0–100 overnight threat score and a plain-English desk brief for any address.", href: "/app?tab=briefing", flagship: true },
  { key: "xray", verb: "X-RAY", title: "Bytecode & EIP-1967 X-Ray", dek: "Proxy slots, admin keys and risky selectors, straight from eth_getCode.", href: "/app?tab=briefing" },
  { key: "sim", verb: "SIMULATE", title: "Simulate the Rug", dek: "Whale dumps and LP pulls, priced with exact BigInt AMM math on live reserves.", href: "/app?tab=chaos" },
  { key: "prove", verb: "PROVE", title: "Bridge Parity Radar", dek: "Locked on Base equals circulating on Robinhood, to the wei.", href: "/app?tab=parity", flagship: true },
  { key: "shield", verb: "SHIELD", title: "Vibestarter Backer Shield", dek: "Tranches, 72-hour challenge windows and LP locks for every escrow.", href: "/app?tab=shield" },
  {
    key: "rescue",
    verb: "RESCUE",
    title: "Atomic Panic Bunker",
    dek: "Revoke risky approvals and unwind to USDC in one signature (EIP-5792).",
    href: `/rescue?target=${DEMO_RESCUE_WALLET.address}&chain=8453`,
    flagship: true,
  },
  { key: "gate", verb: "GATE", title: "Agent Pre-Trade Gate", dek: "ALLOW / WARN / BLOCK for trading agents over x402 and MCP.", href: "/agents" },
  { key: "page", verb: "PAGE", title: "Night-Shift Pager", dek: "Telegram and webhook pages that deep-link straight into the bunker.", href: "/app?tab=pager" },
];

type Figs = Partial<Record<string, ReactNode>>;

export function InstrumentIndexSection() {
  return (
    <Wrap as="section" className="sec-y pt-0 min-[901px]:pt-0">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <Kicker>The desk</Kicker>
          <SplitWords parts={["Eight instruments. One desk."]} className="t-h2 mt-5" d={140} />
        </div>
        <div {...rv(2, "up", 300)}>
          <InkLink href="/app" className="text-[15px]">
            Open the workspace
          </InkLink>
        </div>
      </div>
      <Suspense fallback={<IndexRows figs={{ rescue: MECHANISM }} />}>
        <LiveIndex />
      </Suspense>
    </Wrap>
  );
}

const MECHANISM = (
  <span className="text-ink-meta">
    1 signature <span className="text-ink-3">·</span> mechanism
  </span>
);

const BAND_TEXT = { NOMINAL: "text-phosphor", ELEVATED: "text-warn", CRITICAL: "text-crit" } as const;
const VERDICT_TEXT = { ALLOW: "text-phosphor", WARN: "text-warn", BLOCK: "text-crit" } as const;

async function LiveIndex() {
  const [scan, parity, escrow, guard] = await Promise.all([getScan(), getParity(), getEscrow(), getGuard()]);
  const figs: Figs = { rescue: MECHANISM };
  if (scan) {
    figs.read = (
      <span className={BAND_TEXT[scan.band]}>
        {scan.score}/100 {scan.band}
      </span>
    );
    if (scan.xray?.isContract) figs.xray = `${scan.xray.byteSize.toLocaleString("en-US")} bytes · ${scan.xray.push4Count} selectors`;
    const pool = scan.pool;
    if (pool && !pool.reservesAreVirtual) {
      const side = pool.token0.address.toLowerCase() === scan.target.address.toLowerCase() ? 0 : pool.token1.address.toLowerCase() === scan.target.address.toLowerCase() ? 1 : null;
      if (side != null) {
        const t = side === 0 ? pool.token0 : pool.token1;
        figs.sim = `${fmtCompact(side === 0 ? pool.reserve0 : pool.reserve1, t.decimals)} ${t.symbol} in pool`;
      }
    }
  }
  if (parity) figs.prove = <span className={BigInt(parity.delta) === 0n ? "text-phosphor" : "text-warn"}>Δ {fmtCompact(parity.delta, 18)}</span>;
  if (escrow) figs.shield = `${escrow.tranches.filter((t) => t.status === "PAID").length} of ${escrow.tranches.length} paid`;
  if (guard) {
    figs.gate = (
      <span className={VERDICT_TEXT[guard.verdict]}>
        {guard.verdict}
        {guard.status === "degraded" && <span className="text-ink-meta"> · degraded</span>}
      </span>
    );
  }
  return <IndexRows figs={figs} />;
}

function IndexRows({ figs }: { figs: Figs }) {
  return (
    <ol className="mt-12 border-b border-hair max-[600px]:mt-8">
      {ROWS.map((r, i) => (
        <li key={r.key} className="relative">
          <Rule strong={i === 0} draw={false} />
          <Link
            href={r.href}
            className="idx-row group grid min-h-[104px] grid-cols-[120px_minmax(0,4fr)_minmax(0,5fr)_200px] items-center gap-6 px-3 py-6 focus-visible:outline-offset-[-1px] max-[900px]:min-h-0 max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:gap-x-4 max-[900px]:gap-y-1.5 max-[900px]:px-0 max-[900px]:py-5"
            {...rv(i, "up", 80)}
          >
            <span aria-hidden="true" className="idx-tick" />
            <span className={cx("mono text-[12px] tracking-[0.14em]", r.flagship ? "text-phosphor" : "text-ink-meta")}>{r.verb}</span>
            <span className="min-w-0 max-[900px]:order-3 max-[900px]:col-span-2">
              <span className={cx("idx-title font-serif leading-[1.1] text-ink", r.flagship ? "text-[clamp(26px,2.6vw,36px)]" : "text-[clamp(24px,2.2vw,28px)]")}>{r.title}</span>
            </span>
            <span className="t-body min-w-0 max-[900px]:order-4 max-[900px]:col-span-2">{r.dek}</span>
            <span className="idx-fig mono tnum min-w-0 text-right text-[13px] text-ink-2 [overflow-wrap:anywhere] max-[900px]:order-2">{figs[r.key] ?? null}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
