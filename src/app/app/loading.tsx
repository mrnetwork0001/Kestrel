// Workspace skeleton: same grid as <Workspace>, hairline bars only, no numbers until the live scan lands.
function Bar({ w, h = "h-3" }: { w: string; h?: string }) {
  return <div className={`${h} ${w} animate-pulse rounded-[2px] bg-white/[0.06]`} />;
}

function PanelSkeleton({ title, rows }: { title: string; rows: number }) {
  return (
    <section className="panel">
      <header className="border-b hairline px-4 py-2.5">
        <p className="label">[ {title} ]</p>
      </header>
      <div className="space-y-3 p-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Bar w="w-9" />
            <Bar w={i % 2 ? "w-2/3" : "w-1/2"} />
            <span className="ml-auto mono text-[12px] text-ink-3">—</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-8 max-[901px]:pt-4 max-[601px]:px-2.5" aria-busy="true" aria-live="polite">
      <div className="panel flex flex-col gap-2 p-2 min-[901px]:flex-row min-[901px]:items-center">
        <div className="flex shrink-0 overflow-hidden rounded-[2px] border hairline mono text-[11px] text-ink-3 max-[901px]:grid max-[901px]:grid-cols-2">
          <span className="px-3 py-2 max-[901px]:flex max-[901px]:min-h-10 max-[901px]:items-center">BASE 8453</span>
          <span className="px-3 py-2 max-[901px]:flex max-[901px]:min-h-10 max-[901px]:items-center">ROBINHOOD 4663</span>
        </div>
        <p className="min-w-0 flex-1 truncate px-2 py-2 mono text-[13px] text-ink-3">
          <span className="text-phosphor">&gt;_</span> <span className="cursor-blink">Reading Base and Robinhood Chain</span>
        </p>
        <div className="rounded-[2px] bg-phosphor/30 px-5 py-2 mono text-[12px] font-semibold text-canvas max-[901px]:flex max-[901px]:min-h-11 max-[901px]:items-center max-[901px]:justify-center">SCANNING…</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 max-[601px]:flex-nowrap max-[601px]:overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-[30px] w-40 animate-pulse rounded-[2px] border hairline max-[901px]:h-10 max-[601px]:shrink-0" />
        ))}
      </div>
      <div className="mt-6 h-[38px] border hairline bg-white/[0.02] max-[901px]:mt-4 max-[901px]:h-[46px]" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] max-[901px]:mt-4 max-[601px]:gap-4">
        <div className="space-y-6">
          <section className="panel">
            <header className="border-b hairline px-4 py-2.5">
              <p className="label">[ 01 // Overnight threat score ]</p>
            </header>
            <div className="p-4">
              <div className="flex items-end gap-3">
                <span className="tnum text-[56px] leading-none text-ink-3">—</span>
                <span className="mb-1.5 mono text-[12px] text-ink-3">/ 100</span>
              </div>
              <div className="mt-3 h-1.5 w-full bg-white/[0.06]" />
            </div>
          </section>
          <PanelSkeleton title="02 // Morning desk brief" rows={3} />
          <PanelSkeleton title="03 // Findings" rows={4} />
        </div>
        <div className="space-y-6">
          <PanelSkeleton title="Evidence" rows={5} />
          <PanelSkeleton title="Bytecode & EIP-1967 X-Ray" rows={4} />
        </div>
      </div>
    </div>
  );
}
