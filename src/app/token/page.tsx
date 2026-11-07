import type { Metadata } from "next";
import Link from "next/link";
import { Panel, SectionLabel } from "@/components/ui";

export const metadata: Metadata = {
  title: "$KEST — Utility design & risk disclosure",
  description: "Proposed non-security utility design for $KEST: watcher-slot staking for always-on monitoring, x402 agent firewall credits, and Panic Bunker automation tiers — with an honest risk disclosure.",
  alternates: { canonical: "/token" },
  openGraph: { title: "$KEST — utility design & honest risk disclosure", description: "Watcher-slot staking, x402 agent firewall credits and Panic Bunker automation tiers. Design only: no token is live." },
};

export default function TokenPage() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 pb-10 pt-12 max-[900px]:pt-8">
      <SectionLabel n="08">$KEST</SectionLabel>
      <h1 className="mt-4 font-serif text-[48px] leading-[1.04] text-ink max-[600px]:text-[36px] max-[600px]:leading-[1.06]">A token that buys compute and protection — not a promise.</h1>
      <div className="mt-6 border border-warn/40 bg-warn/[0.05] p-4 text-[13px] text-ink-2">
        <span className="mono text-warn">STATUS · </span>$KEST is a proposed design. No token has been deployed, sold or promised. Nothing on this page is an offer, and Kestrel works today with no token at all.
      </div>

      <section className="mt-12 grid gap-6 max-[900px]:mt-8 max-[600px]:gap-4 md:grid-cols-3 [&>*]:min-w-0">
        <Panel title="Watcher slots" n="01">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Stake $KEST to reserve always-on watcher capacity: sub-block polling of your wallets, pools and Vibestarter escrows, evaluated against your Pager rules around the clock.
            Slots are capacity, not yield — unstake and the capacity is released.
          </p>
        </Panel>
        <Panel title="Agent firewall credits" n="02">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Today agents pay full guard verdicts per call in USDC via x402. $KEST would let operators prepay discounted credit bundles for high-frequency pre-trade checks, consumed as calls are made.
          </p>
        </Panel>
        <Panel title="Panic Bunker policies" n="03">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Tiered automation: pre-built rescue bundles staged for your wallet, delivered via Pager deep links the moment a rule fires — always signed by you, never custodial.
          </p>
        </Panel>
      </section>

      <section className="mt-12 grid gap-6 max-[900px]:mt-8 max-[600px]:gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel title="Demand sinks" n="04">
          <ul className="space-y-2 text-[13px] text-ink-2">
            <li>· Watcher-slot staking scales with monitored addresses, not speculation.</li>
            <li>· Agent credits are consumed per guard call.</li>
            <li>· Fee rebates on x402 calls for staked operators.</li>
            <li>· Vibestarter backers get Backer Shield watchers on the escrows they fund.</li>
          </ul>
        </Panel>
        <Panel title="What $KEST is not" n="05">
          <ul className="space-y-2 text-[13px] text-ink-2">
            <li>· Not equity, debt or a claim on revenue.</li>
            <li>· No yield promised from staking — slots are a service reservation.</li>
            <li>· Not required: every core feature is free or USDC-payable today.</li>
            <li>· Not custody: Kestrel never holds user funds or keys.</li>
          </ul>
        </Panel>
      </section>

      <section className="mt-12 max-[900px]:mt-8">
        <Panel title="Risk disclosure" n="06">
          <div className="space-y-3 text-[13px] leading-relaxed text-ink-2">
            <p>Any future token may lose all value. Utility tokens can be illiquid, volatile and subject to changing regulation in your jurisdiction.</p>
            <p>
              Kestrel&apos;s scores are automated heuristics from public onchain data. They can be wrong, incomplete or late: public RPCs can lag, prune history or reject queries;
              novel exploits will not match known selectors; AMM simulations assume the modelled liquidity. A NOMINAL score is not a guarantee of safety, and a BLOCK is not an accusation.
            </p>
            <p>Rescue transactions are simulated before signing, but simulation cannot rule out state changing between simulation and inclusion. You remain responsible for every transaction you sign.</p>
            <p>Nothing on this site is financial, investment or legal advice.</p>
          </div>
        </Panel>
      </section>

      <div className="mt-12 flex flex-wrap gap-4 max-[900px]:mt-8 max-[600px]:gap-3">
        <Link href="/app" className="rounded-[2px] bg-phosphor px-5 py-3 mono text-[13px] font-semibold text-canvas hover:bg-[#a6e698] max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">LAUNCH APP</Link>
        <Link href="/agents" className="rounded-[2px] border border-hair-strong px-5 py-3 mono text-[13px] text-ink hover:border-phosphor/60 max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:items-center">x402 agent API</Link>
      </div>
    </div>
  );
}
