"use client";

import { useEffect, useState } from "react";
import { chainName } from "@/lib/format";
import type { ThreatBand } from "@/lib/engine/types";

const BTN = "press inline-flex min-h-9 items-center rounded-[2px] border border-hair-strong px-3 mono text-[11px] tracking-[0.08em] text-ink-2 transition-colors hover:border-phosphor/60 hover:text-phosphor max-[901px]:min-h-11";

/** Copy / X / Farcaster share for the current scan, with a live preview of its /api/card Threat Card. */
/** An instrument: render it inside a popover/<details>; it carries no border of its own. */
export function ShareCard({ address, chainId, label, score, band, className }: { address: string; chainId: number; label: string; score: number; band: ThreatBand; className?: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const q = `target=${address}&chain=${chainId}`;
  const url = `${origin}/app?${q}`;
  const text = `${label} on ${chainName(chainId)}: overnight threat score ${score}/100 (${band}), live from Kestrel.`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={["flex items-center gap-4 max-[601px]:flex-col max-[601px]:items-start", className].filter(Boolean).join(" ")}>
      <a href={`/api/card?${q}`} target="_blank" rel="noreferrer" className="press shrink-0 opacity-90 transition-opacity hover:opacity-100" title="Open Threat Card image">
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic PNG from our own route */}
        <img src={`/api/card?${q}`} alt={`Threat Card for ${label}`} width={160} height={84} loading="lazy" className="block h-[84px] w-[160px] bg-canvas" />
      </a>
      <div className="min-w-0">
        <p className="t-kicker mb-2">Share threat card</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={copy} disabled={!origin} className={BTN}>
            {copied ? "COPIED" : "COPY LINK"}
          </button>
          <a href={origin ? `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}` : undefined} target="_blank" rel="noreferrer" className={BTN}>
            SHARE ON X
          </a>
          <a href={origin ? `https://farcaster.xyz/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(url)}` : undefined} target="_blank" rel="noreferrer" className={BTN}>
            SHARE ON FARCASTER
          </a>
        </div>
      </div>
    </div>
  );
}
