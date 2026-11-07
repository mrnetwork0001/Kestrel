import { InkLink, Kicker, Rule, Wrap } from "@/components/editorial";
import { cx } from "@/components/ui";
import { rv, SplitWords } from "@/components/motion";

const TERMS = [
  { t: "Watcher slots", d: "Stake for always-on, sub-block monitoring of your wallets, pools and escrows." },
  { t: "Agent firewall credits", d: "Prepay x402 guard calls at a discount, so agents never stall on a payment." },
  { t: "Bunker policies", d: "Pre-authorized Panic Bunker rescue tiers that run while you sleep." },
];

/** S5 · $KEST: paper on canvas. Headline (4 cols) + a 3-column definition list split by vertical hairlines (8 cols). */
export function TokenSection() {
  return (
    <Wrap as="section" id="kest" className="py-24 max-[901px]:py-[72px] max-[601px]:py-16">
      <Rule strong />
      <div className="mt-10 grid gap-10 min-[901px]:grid-cols-12 min-[901px]:gap-6">
        <div className="min-w-0 min-[901px]:col-span-4">
          <Kicker d={80}>$KEST utility</Kicker>
          <SplitWords as="h2" className="t-h2 mt-5 !text-[40px] !leading-[1.08] max-[601px]:!text-[34px]" parts={["The token pays", "br", "for the watch."]} d={140} />
        </div>
        <dl className="min-w-0 divide-y divide-hair border-y border-hair min-[901px]:col-span-8 min-[901px]:grid min-[901px]:grid-cols-3 min-[901px]:divide-y-0 min-[901px]:border-y-0">
          {TERMS.map((x, i) => (
            <div key={x.t} className={cx("min-w-0 py-6 min-[901px]:py-1", i > 0 && "min-[901px]:border-l min-[901px]:border-hair min-[901px]:pl-6", i < 2 && "min-[901px]:pr-6")} {...rv(i, "up", 300)}>
              <dt className="font-serif text-[22px] leading-tight text-ink">{x.t}</dt>
              <dd className="mt-3 text-[15px] leading-relaxed text-ink-2">{x.d}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="t-meta mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 min-[901px]:ml-[calc((100%+24px)/3)]" {...rv(3, "up", 380)}>
        <span>† Utility design only. No token is live.</span>
        <InkLink href="/token" className="text-ink-2">
          Read the risk disclosure
        </InkLink>
      </p>
    </Wrap>
  );
}

/** @deprecated name kept so page.tsx keeps compiling until landing-top switches to TokenSection. */
export const TokenPanel = TokenSection;
