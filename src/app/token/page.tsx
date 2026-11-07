import type { Metadata } from "next";
import Link from "next/link";
import { Kicker } from "@/components/editorial";
import { rv } from "@/components/motion";
import { Chapter, DocActions, DocGrid, PageMasthead } from "@/components/page-masthead";

export const metadata: Metadata = {
  title: "$KEST — Utility design & risk disclosure",
  description: "Proposed non-security utility design for $KEST: watcher-slot staking for always-on monitoring, x402 agent firewall credits, and Panic Bunker automation tiers — with an honest risk disclosure.",
  alternates: { canonical: "/token" },
  openGraph: { title: "$KEST — utility design & honest risk disclosure", description: "Watcher-slot staking, x402 agent firewall credits and Panic Bunker automation tiers. Design only: no token is live." },
};

const TOC = [
  { id: "utility", label: "Utility" },
  { id: "tiers", label: "Tiers" },
  { id: "not", label: "What it is not" },
  { id: "risk", label: "Risk disclosure" },
];

const UTILITY: { term: string; def: string }[] = [
  {
    term: "Watcher slots",
    def: "Stake $KEST to reserve always-on watcher capacity: sub-block polling of your wallets, pools and Vibestarter escrows, evaluated against your Pager rules around the clock. Slots are capacity, not yield. Unstake and the capacity is released.",
  },
  {
    term: "Agent firewall credits",
    def: "Today agents pay for full guard verdicts per call in Base USDC via x402. $KEST would let operators prepay discounted credit bundles for high-frequency pre-trade checks, consumed as calls are made, with fee rebates for staked operators.",
  },
  {
    term: "Panic Bunker policies",
    def: "Tiered automation: rescue bundles pre-built for your wallet and delivered through Pager deep links the moment a rule fires. Always signed by you, never custodial.",
  },
  {
    term: "Backer Shield watchers",
    def: "Vibestarter backers get dedicated watchers on the escrows they fund, so a 72-hour challenge window never opens unnoticed.",
  },
];

/** Proposed tiers. Prices are deliberately absent: no token exists, so no token price or stake size is quoted. */
const TIERS = {
  cols: ["Today", "Staked watcher (proposed)", "Agent operator (proposed)"],
  rows: [
    { k: "Night Shift briefing, Rug Lab, parity, X-Ray", v: ["Free", "Free", "Free"] },
    { k: "Guard verdicts", v: ["Preview free, full per call in USDC (x402)", "Same as today", "Prepaid credit bundles"] },
    { k: "x402 fee rebates", v: ["None", "None", "For staked operators"] },
    { k: "Pager watches", v: ["Polled on the pager tick", "Always-on slot, sub-block polling", "Always-on slots"] },
    { k: "Panic Bunker", v: ["Built on demand, you sign", "Pre-built bundles in alerts, you sign", "Pre-built bundles in alerts, you sign"] },
  ],
};

export default function TokenPage() {
  return (
    <article className="min-w-0">
      <PageMasthead
        kicker="$KEST · utility design"
        title={["The token pays", "for the watch."]}
        dek="A proposed design for a token that buys compute and protection, not a promise. No token is live."
        meta={
          <>
            <span className="text-warn">STATUS: DESIGN ONLY</span>
            <span className="text-ink-3">·</span>
            <span>Kestrel works today with no token at all</span>
          </>
        }
      />

      <DocGrid toc={TOC}>
        <Chapter id="utility" kicker="Utility" tone="phosphor" title={["Four things $KEST would buy."]}>
          <p>Every use consumes Kestrel capacity: watcher time, guard calls or pre-built rescue bundles. None of them pays out.</p>
          <dl className="!mt-8 divide-y divide-hair border-y border-hair">
            {UTILITY.map((u, i) => (
              <div key={u.term} {...rv(i)} className="grid gap-x-8 gap-y-2 py-6 min-[1101px]:grid-cols-[minmax(0,14ch)_minmax(0,1fr)]">
                <dt className="font-serif text-[26px] leading-[1.15] text-ink">{u.term}</dt>
                <dd className="text-[16px] leading-relaxed text-ink-2 [text-wrap:pretty]">{u.def}</dd>
              </div>
            ))}
          </dl>
        </Chapter>

        <Chapter
          id="tiers"
          kicker="Tiers"
          tone="phosphor"
          title={["What each tier gets."]}
          wide={
            <div className="max-w-full overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <caption className="sr-only">Proposed $KEST tiers. Design only; no token is live.</caption>
                <thead>
                  <tr className="border-b border-hair-strong">
                    <th scope="col" className="py-3 pr-4 align-bottom t-kicker font-normal">Capability</th>
                    {TIERS.cols.map((c, i) => (
                      <th key={c} scope="col" className={`py-3 pr-4 align-bottom t-kicker font-normal ${i === 1 ? "!text-phosphor" : ""}`}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hair">
                  {TIERS.rows.map((r, i) => (
                    <tr key={r.k} {...rv(i)} className="align-top">
                      <th scope="row" className="py-3.5 pr-4 text-[14px] font-normal text-ink">
                        {r.k}
                      </th>
                      {r.v.map((v, j) => (
                        <td key={j} className={`py-3.5 pr-4 mono text-[13px] ${v === "None" ? "text-ink-meta" : j === 0 ? "text-ink" : "text-ink-2"}`}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 t-meta">No stake sizes or prices are quoted, because no token exists to price.</p>
            </div>
          }
        >
          <p>Every core feature stays free or USDC-payable. Staking reserves capacity; it never unlocks safety you would otherwise lack.</p>
        </Chapter>

        <Chapter id="not" kicker="Boundaries" title={["What $KEST is not."]}>
          <ul className="space-y-3">
            <li>Not equity, debt or a claim on revenue.</li>
            <li>No yield is promised from staking. Slots are a service reservation.</li>
            <li>Not required: every core feature is free or USDC-payable today.</li>
            <li>Not custody: Kestrel never holds user funds or keys.</li>
          </ul>
        </Chapter>

        <section id="risk" aria-labelledby="risk-h" className="scroll-mt-28 pb-16 max-[901px]:pb-12">
          <div {...rv(0)} className="border-l-2 border-warn pl-8 max-[601px]:pl-5">
            <Kicker tone="warn">Risk disclosure</Kicker>
            <h2 id="risk-h" className="mt-4 font-serif text-[40px] leading-[1.05] text-ink max-[601px]:text-[32px]">
              No token is live.
            </h2>
            <div className="mt-6 max-w-[66ch] space-y-4 text-[15px] leading-relaxed text-ink">
              <p>
                $KEST is a proposed design. No token has been deployed, sold or promised, and nothing on this page is an offer.<sup className="text-warn">†</sup>
              </p>
              <p>Any future token may lose all value. Utility tokens can be illiquid, volatile and subject to changing regulation in your jurisdiction.</p>
              <p>
                Kestrel&apos;s scores are automated heuristics from public onchain data. They can be wrong, incomplete or late: public RPCs can lag, prune history or reject
                queries; novel exploits will not match known selectors; AMM simulations assume the modelled liquidity. A NOMINAL score is not a guarantee of safety, and a
                BLOCK is not an accusation.<sup className="text-warn">††</sup>
              </p>
              <p>
                Rescue transactions are simulated before signing, but simulation cannot rule out state changing between simulation and inclusion. You remain responsible for
                every transaction you sign.
              </p>
              <p>Nothing on this site is financial, investment or legal advice.</p>
            </div>
            <ol className="mt-6 max-w-[66ch] space-y-1.5 border-t border-hair pt-4 t-meta">
              <li>† Kestrel works today with no token: every feature in the app is free or paid per call in Base USDC.</li>
              <li>†† Every score lists the findings and points it is built from, each with a block number and an explorer link.</li>
            </ol>
          </div>
        </section>

        <DocActions>
          <Link href="/app" className="btn-primary press">
            LAUNCH APP
          </Link>
          <Link href="/agents" className="btn-ghost press">
            x402 agent API
          </Link>
        </DocActions>
      </DocGrid>
    </article>
  );
}
