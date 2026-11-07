import Anthropic from "@anthropic-ai/sdk";
import { chainName, fmtBps, shortAddr } from "@/lib/format";
import type { BriefResult, Finding, ScanResult } from "./types";

type BriefInput = Pick<ScanResult, "target" | "score" | "band" | "findings" | "block" | "pool" | "parity" | "escrow" | "wallet" | "flow" | "token">;

/** Deterministic Morning Desk Brief built only from live onchain findings — always available, never fabricated. */
export function deterministicBrief(s: BriefInput): string {
  const sev = (f: Finding) => (f.severity === "critical" ? 0 : f.severity === "warn" ? 1 : 2);
  const ranked = [...s.findings].sort((a, b) => sev(a) - sev(b) || b.points - a.points);
  const crit = ranked.filter((f) => f.severity === "critical");
  const warn = ranked.filter((f) => f.severity === "warn");
  const name = s.token ? `${s.token.symbol}` : s.escrow?.title ?? shortAddr(s.target.address);
  const lines: string[] = [];
  lines.push(
    `${s.band} · ${s.score}/100 — ${name} on ${chainName(s.target.chainId)} at block #${BigInt(s.block.number).toLocaleString("en-US")}.`
  );
  if (crit.length) lines.push(`Act first: ${crit.map((f) => f.title).join("; ")}.`);
  if (warn.length) lines.push(`Watch: ${warn.slice(0, 4).map((f) => f.title).join("; ")}.`);
  if (s.pool) {
    const o = s.pool.overnight;
    const bits: string[] = [];
    if (o.reserve0ChangeBps !== null) bits.push(`LP depth ${fmtBps(o.reserve0ChangeBps)}`);
    if (o.priceChangeBps !== null) bits.push(`price ${fmtBps(o.priceChangeBps)}`);
    if (o.swapCount !== null) bits.push(`${o.swapCount} swaps`);
    if (bits.length) lines.push(`Overnight (${o.hours}h): ${bits.join(", ")}.`);
  }
  if (s.parity) {
    lines.push(
      `$VIBES bridge: ${s.parity.verified ? "1:1 OFT parity exact" : "parity DRIFT detected"}; cross-venue spread ${s.parity.spreadBps !== null ? fmtBps(s.parity.spreadBps) : "n/a"}${s.parity.cheaperVenue ? `, cheaper on ${s.parity.cheaperVenue === "base" ? "Base" : "Robinhood Chain"}` : ""}.`
    );
  }
  if (s.flow?.available) lines.push(`Token flow: ${s.flow.transferCount} transfers in ${s.flow.hours}h.`);
  if (!crit.length && !warn.length) lines.push("Nothing actionable overnight. Go back to sleep.");
  else if (s.wallet?.approvals.length) lines.push("Panic Bunker can revoke every flagged approval in one atomic batch.");
  return lines.join(" ");
}

function promptFor(s: BriefInput, fallback: string): string {
  const facts = {
    target: s.target,
    score: s.score,
    band: s.band,
    block: s.block,
    findings: s.findings.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })),
    overnightPool: s.pool?.overnight ?? null,
    parity: s.parity ? { verified: s.parity.verified, spreadBps: s.parity.spreadBps, cheaperVenue: s.parity.cheaperVenue, netEdgeBps: s.parity.netEdgeBps } : null,
  };
  return [
    "You are the overnight risk desk at Kestrel, a non-custodial onchain sentinel for Base and Robinhood Chain.",
    "Write a Morning Desk Brief of at most 110 words in plain text (no markdown, no lists, no emojis).",
    "Lead with the single most important action or the all-clear. Use ONLY the facts in the JSON below — never invent numbers, names, or events. Do not give financial advice.",
    "",
    JSON.stringify(facts),
    "",
    `Reference rule-based brief (for tone only): ${fallback}`,
  ].join("\n");
}

/** 0G Compute Router — OpenAI-compatible /chat/completions (https://docs.0g.ai). */
async function via0G(prompt: string): Promise<BriefResult | null> {
  const key = process.env.ZG_COMPUTE_API_KEY;
  const model = process.env.ZG_COMPUTE_MODEL;
  const baseUrl = (process.env.ZG_COMPUTE_BASE_URL || "https://router-api.0g.ai/v1").replace(/\/+$/, "");
  if (!key || !model) return null;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`0G Compute HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  return text ? { text: sanitize(text), source: "0g-compute", model } : null;
}

/** Direct Anthropic API via the official SDK (server-side fallback enabled for refusals). */
async function viaAnthropic(prompt: string): Promise<BriefResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
  const msg = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: prompt }],
  });
  if (msg.stop_reason === "refusal") return null;
  const text = msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return text ? { text: sanitize(text), source: "anthropic", model: msg.model } : null;
}

function sanitize(t: string): string {
  return t.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").slice(0, 900);
}

/**
 * Free-form completion through the same provider chain (0G Compute → Anthropic). Returns null when no
 * provider is configured, every provider fails, or the overall cap elapses — callers own the deterministic
 * fallback. Never throws.
 */
export async function llmComplete(prompt: string, opts: { timeoutMs?: number } = {}): Promise<BriefResult | null> {
  const run = async () => {
    for (const fn of [via0G, viaAnthropic]) {
      try {
        const r = await fn(prompt);
        if (r) return r;
      } catch (e) {
        console.warn("[kestrel] llmComplete provider failed:", e instanceof Error ? e.message : e);
      }
    }
    return null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), opts.timeoutMs ?? 15_000)));
  try {
    return await Promise.race([run(), cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** 0G Compute → Anthropic → deterministic. Never throws, never returns fabricated text. */
export async function generateBrief(s: BriefInput, opts: { useLlm?: boolean } = {}): Promise<BriefResult> {
  const fallback = deterministicBrief(s);
  if (opts.useLlm === false) return { text: fallback, source: "deterministic", model: null };
  const prompt = promptFor(s, fallback);
  for (const fn of [via0G, viaAnthropic]) {
    try {
      const r = await fn(prompt);
      if (r) return r;
    } catch (e) {
      console.warn("[kestrel] brief provider failed:", e instanceof Error ? e.message : e);
    }
  }
  return { text: fallback, source: "deterministic", model: null };
}
