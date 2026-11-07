/**
 * Pager deep links: always built on the canonical public origin (siteUrl()), never on a request Host.
 *
 * Telegram (and some Slack/Discord clients) reject inline buttons whose URL is localhost or plain http
 * ("wrong HTTP URL"), so `buttonUrl()` returns null unless the origin is public https; renderers then fall back
 * to printing the link as plain text.
 */
import { siteUrl } from "@/lib/site";
import { explorerAddress, explorerTx } from "@/lib/format";
import type { ChainId } from "@/lib/engine/types";
import type { Watch } from "@/lib/pager/types";

export interface LinkRef {
  label: string;
  href: string;
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/i;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

/** Canonical origin for links printed as text (may be http://localhost:3002 in dev). */
export function appOrigin(): string {
  return siteUrl();
}

/** Public https origin suitable for clickable buttons, or null in local dev. */
export function publicAppOrigin(): string | null {
  const o = siteUrl();
  try {
    const u = new URL(o);
    return u.protocol === "https:" && !LOCAL.test(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}

/** Resolves a relative app path ("/rescue?…") or absolute URL against the canonical origin. */
export function absUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${appOrigin()}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * URL usable as a button target: absolute https on a public host. App-relative links resolve only when the app
 * has a public https origin; explorer links (already https) always qualify.
 */
export function buttonUrl(href: string): string | null {
  let abs: string;
  if (/^https?:\/\//i.test(href)) abs = href;
  else {
    const pub = publicAppOrigin();
    if (!pub) return null;
    abs = `${pub}${href.startsWith("/") ? "" : "/"}${href}`;
  }
  try {
    const u = new URL(abs);
    return u.protocol === "https:" && !LOCAL.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

/** Relative Panic Bunker deep link (Base only). `revoke` = "token:spender" preselects one approval. */
export function rescueHref(target: string | null, opts: { chainId?: ChainId; revoke?: string } = {}): string {
  const revoke = opts.revoke && /^0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]{40}$/.test(opts.revoke) ? opts.revoke : undefined;
  return `/rescue?${q({ target: target && ADDR.test(target) ? target : undefined, chain: 8453, from: "pager", revoke })}`;
}

/** Relative workspace link for a target and tab. */
export function appHref(target: string, chainId: ChainId, tab?: "briefing" | "chaos" | "parity" | "shield" | "bunker" | "pager"): string {
  return `/app?${q({ target: ADDR.test(target) ? target : undefined, chain: chainId, tab })}`;
}

/** Kind-aware primary/secondary actions for a watch (spec §10.1). Hrefs are app-relative; renderers absolutize. */
export function watchActions(w: Pick<Watch, "kind" | "chainId" | "target">, extra: { revoke?: string } = {}): LinkRef[] {
  switch (w.kind) {
    case "wallet":
      return w.chainId === 8453
        ? [{ label: "Revoke in Panic Bunker", href: rescueHref(w.target, { revoke: extra.revoke }) }]
        : [{ label: "Open briefing", href: appHref(w.target, w.chainId, "briefing") }];
    case "token":
    case "pool":
      return [
        { label: "Simulate exit", href: appHref(w.target, w.chainId, "chaos") },
        { label: "Open Panic Bunker", href: rescueHref(null) },
      ];
    case "escrow":
      return [{ label: "Backer Shield", href: appHref(w.target, w.chainId, "shield") }];
    default:
      return [{ label: "Open briefing", href: appHref(w.target, w.chainId, "briefing") }];
  }
}

/** Explorer evidence: the tx when known, else the target address. Only validated hex is interpolated. */
export function evidenceLinks(chainId: ChainId, target: string, txHash?: string | null): LinkRef[] {
  const out: LinkRef[] = [];
  const explorer = chainId === 4663 ? "Blockscout" : "Basescan";
  if (txHash && TX.test(txHash)) out.push({ label: `${explorer} tx`, href: explorerTx(chainId, txHash) });
  if (ADDR.test(target)) out.push({ label: txHash ? "Target" : explorer, href: explorerAddress(chainId, target) });
  return out;
}

/** Link to the pager tab / desk in the app (used in digests and link confirmations). */
export function pagerHref(): string {
  return "/app?tab=pager";
}
