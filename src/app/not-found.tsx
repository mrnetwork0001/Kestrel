import type { Metadata } from "next";
import Link from "next/link";
import { Kicker, Wrap } from "@/components/editorial";
import { SplitWords } from "@/components/motion";

export const metadata: Metadata = { title: "404 · Signal lost", robots: { index: false } };

const LINKS = [
  { href: "/", label: "Night Shift briefing", cmd: "cd /" },
  { href: "/app", label: "Sentinel workspace", cmd: "open /app" },
  { href: "/how-it-works", label: "How Kestrel works", cmd: "man kestrel" },
];

export default function NotFound() {
  return (
    <Wrap className="py-24 max-[901px]:py-12">
      <div className="max-w-[880px]">
        <Kicker tone="crit">404 · Signal lost</Kicker>
        <SplitWords as="h1" mode="load" parts={["Nothing to watch here."]} className="t-hero mt-5 max-w-[18ch]" />
        <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-ink-2">
          The route you requested does not exist. The sentinel is still reading Base and Robinhood Chain; pick a station below.
        </p>
        <div className="panel mt-10 min-w-0 px-5 py-4 max-[601px]:px-4">
          <p className="mono text-[13px] text-ink-meta">kestrel@night-shift:~$ resolve route</p>
          <p className="mt-1.5 mono text-[13px] text-crit [overflow-wrap:anywhere]">error: no contract, page or endpoint at this path</p>
          <p className="mt-1.5 mono text-[13px] text-ink-meta cursor-blink">awaiting input</p>
        </div>
        <ul className="mt-10 divide-y divide-hair border-y border-hair">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="idx-row group flex items-center gap-4 py-4 max-[901px]:min-h-11 max-[601px]:gap-3">
                <span className="w-32 shrink-0 whitespace-nowrap pl-3 mono text-[13px] text-phosphor">&gt;_ {l.cmd}</span>
                <span className="idx-title min-w-0 text-[16px] text-ink-2 transition-[transform,color] duration-200 group-hover:text-ink">{l.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Wrap>
  );
}
