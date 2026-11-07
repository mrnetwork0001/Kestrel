import { Kicker, Rule, Wrap } from "@/components/editorial";
import { rv, SplitWords } from "@/components/motion";

/** S2 · The Problem: three ruled dispatches (paper, no boxes). */
const DISPATCHES = [
  {
    k: "03:42 UTC",
    t: "An approval you forgot gets drained.",
    d: "Unlimited ERC-20 and Permit2 allowances outlive the apps you granted them to. Revoking eight, one popup at a time, mid-exploit, fails halfway.",
  },
  {
    k: "2 CHAINS",
    t: "Bridged supply can quietly de-peg.",
    d: "If locked ≠ circulating, someone minted unbacked $VIBES. Nobody checks the invariant block by block.",
  },
  {
    k: "72 HOURS",
    t: "Backers miss the only window that matters.",
    d: "Founders request each 15% tranche in public; backers get 72 hours to challenge. Most find out after the money moved.",
  },
];

export function ProblemSection() {
  return (
    <Wrap as="section" className="sec-y">
      <div className="grid gap-12 min-[901px]:grid-cols-12 min-[901px]:gap-6 max-[900px]:gap-8">
        <div className="min-w-0 min-[901px]:col-span-5">
          <Kicker>The problem</Kicker>
          <SplitWords parts={["Markets run all night.", "br", "Your alarm doesn’t."]} className="t-h2 mt-5" d={140} />
        </div>
        <ol className="min-w-0 min-[901px]:col-span-7">
          {DISPATCHES.map((x, i) => (
            <li key={x.k} className="relative pb-8 last:pb-0">
              <Rule strong={i === 0} d={i * 60} />
              <div className="pt-6" {...rv(i, "up", 80)}>
                <p className="mono text-[12px] tracking-[0.14em] text-phosphor">{x.k}</p>
                <h3 className="t-h3 mt-3 text-ink">{x.t}</h3>
                <p className="t-body mt-3 max-w-[58ch]">{x.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Wrap>
  );
}
