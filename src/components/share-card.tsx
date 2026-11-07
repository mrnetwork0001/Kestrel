"use client";

import { useEffect, useState } from "react";
import { chainName } from "@/lib/format";
import type { ThreatBand } from "@/lib/engine/types";

const BTN = "rounded-[2px] border border-hair-strong px-2.5 py-1 mono text-[10px] tracking-wider text-ink-2 hover:border-phosphor/60 hover:text-phosphor";

/** Copy / X / Farcaster share for the current scan, with a live preview of its /api/card Threat Card. */
export function ShareCard({ address, chainId, label, score, band }: { address: string; chainId: number; label: string; score: number; band: ThreatBand }) {
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
    <div className="mt-4 flex items-center gap-3 border-t hairline pt-4">
      <a href={`/api/card?${q}`} target="_blank" rel="noreferrer" className="shrink-0 border hairline hover:border-hair-strong" title="Open Threat Card image">
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic PNG from our own route */}
        <img src={`/api/card?${q}`} alt={`Threat Card for ${label}`} width={128} height={67} loading="lazy" className="block h-[67px] w-[128px] bg-canvas" />
      </a>
      <div className="min-w-0">
        <p className="label mb-2">Share threat card</p>
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
