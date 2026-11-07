import type { Metadata } from "next";
import Link from "next/link";
import { SectionLabel } from "@/components/ui";

export const metadata: Metadata = { title: "404 · Signal lost", robots: { index: false } };

const LINKS = [
  { href: "/", label: "Night Shift briefing", cmd: "cd /" },
  { href: "/app", label: "Sentinel workspace", cmd: "open /app" },
  { href: "/how-it-works", label: "How Kestrel works", cmd: "man kestrel" },
];

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[880px] px-4 py-24 max-[901px]:py-12">
      <SectionLabel n="404">Signal lost</SectionLabel>
      <div className="panel mt-4 min-w-0 p-6 max-[601px]:p-4">
        <p className="mono text-[13px] text-ink-3">kestrel@night-shift:~$ resolve route</p>
        <p className="mt-2 mono text-[13px] text-crit [overflow-wrap:anywhere]">error: no contract, page or endpoint at this path</p>
        <h1 className="mt-6 font-serif text-[56px] leading-none text-ink max-[601px]:text-[40px] max-[601px]:leading-[1.05]">Nothing to watch here.</h1>
        <p className="mt-3 max-w-[560px] text-[14px] text-ink-2">The route you requested does not exist. The sentinel is still reading Base and Robinhood Chain; pick a station below.</p>
        <ul className="mt-8 divide-y divide-white/[0.06] border-y hairline">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="group flex items-center gap-4 py-3 max-[901px]:min-h-11 hover:bg-white/[0.02] max-[601px]:gap-3">
                <span className="w-28 shrink-0 whitespace-nowrap mono text-[12px] text-phosphor">&gt;_ {l.cmd}</span>
                <span className="min-w-0 text-[14px] text-ink-2 group-hover:text-ink">{l.label}</span>
                <span className="ml-auto mono text-[12px] text-ink-3 group-hover:text-ink">→</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4 mono text-[12px] text-ink-3 cursor-blink">awaiting input</p>
      </div>
    </div>
  );
}
