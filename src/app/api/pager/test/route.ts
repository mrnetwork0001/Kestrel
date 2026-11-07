import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { CONTRACTS } from "@/config/contracts";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { readAllEscrows } from "@/lib/engine/escrow";
import { getBridgeParity } from "@/lib/engine/parity";
import { readPool } from "@/lib/engine/pools";
import { fmtBps, fmtDuration, fmtUnits, shortAddr } from "@/lib/format";
import { siteUrl } from "@/lib/site";

export const runtime = "nodejs";
export const maxDuration = 45;

interface Body {
  webhookUrl?: string;
  telegramChatId?: string;
  target?: string;
  chainId?: number;
  rules?: { lpDropPct?: number; maxSpreadBps?: number; watchChallengeWindows?: boolean; parityDrift?: boolean };
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** SSRF guard: https only, no credentials, public DNS resolution only. */
async function assertSafeWebhook(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("Webhook must use https://");
  if (u.username || u.password) throw new Error("Webhook URL must not embed credentials");
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Webhook host not allowed");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Webhook resolves to a private address");
  return u;
}

/**
 * POST /api/pager/test — evaluates the user's armed rules against LIVE chain state and dispatches a
 * real Night-Shift Pager alert (webhook and/or Telegram) with a 1-click /rescue deep link.
 */
export async function POST(req: Request) {
  if (await rateLimited(req, 6)) return apiError("Rate limited — max 6 test pages per minute.", 429);
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return apiError("Body must be JSON.");
  }
  const rules = {
    lpDropPct: Math.max(1, Math.min(90, Number(body.rules?.lpDropPct ?? 15))),
    maxSpreadBps: Math.max(10, Math.min(5000, Number(body.rules?.maxSpreadBps ?? 300))),
    watchChallengeWindows: body.rules?.watchChallengeWindows !== false,
    parityDrift: body.rules?.parityDrift !== false,
  };
  const chainId = normalizeChainId(body.chainId ?? 8453);
  const target = parseAddress(body.target) ?? CONTRACTS.base.vibesToken;

  let webhook: URL | null = null;
  if (body.webhookUrl) {
    try {
      webhook = await assertSafeWebhook(body.webhookUrl);
    } catch (e) {
      return apiError(errMsg(e));
    }
  }
  const tgChat = body.telegramChatId && /^-?\d{4,20}$/.test(body.telegramChatId) ? body.telegramChatId : null;

  try {
    const [parity, escrows, basePool] = await Promise.all([
      getBridgeParity({ overnight: false }),
      rules.watchChallengeWindows ? readAllEscrows() : Promise.resolve([]),
      readPool(8453, CONTRACTS.base.vibesAerodromePool),
    ]);

    const lpDelta = basePool?.overnight.reserve0ChangeBps ?? null;
    const openWindows = escrows.flatMap((e) => e.tranches.filter((t) => t.status === "CHALLENGE_WINDOW").map((t) => ({ e, t })));
    const triggers = [
      { rule: `Aerodrome VIBES LP drop > ${rules.lpDropPct}% (8h)`, fired: lpDelta !== null && lpDelta <= -rules.lpDropPct * 100, observed: lpDelta !== null ? fmtBps(lpDelta) : "n/a" },
      { rule: `Base ↔ RH spread > ${(rules.maxSpreadBps / 100).toFixed(1)}%`, fired: parity.spreadBps !== null && Math.abs(parity.spreadBps) > rules.maxSpreadBps, observed: parity.spreadBps !== null ? fmtBps(parity.spreadBps) : "n/a" },
      ...(rules.parityDrift ? [{ rule: "$VIBES OFT 1:1 parity drift", fired: !parity.verified, observed: parity.verified ? "Δ 0" : `Δ ${fmtUnits(parity.delta, 18, 4)}` }] : []),
      ...(rules.watchChallengeWindows ? [{ rule: "Vibestarter 72h challenge window open", fired: openWindows.length > 0, observed: openWindows.length ? `${openWindows.length} open` : "none" }] : []),
    ];

    const deepLink = `${siteUrl(req)}/rescue?target=${target}&chain=${chainId}`;
    const fired = triggers.filter((t) => t.fired);
    const lines = [
      `>_ KESTREL NIGHT-SHIFT PAGER · TEST`,
      `${fired.length ? `${fired.length} rule(s) FIRED` : "All armed rules clear"} · Base #${BigInt(parity.base.number).toLocaleString("en-US")} · RH #${BigInt(parity.robinhood.number).toLocaleString("en-US")}`,
      ...triggers.map((t) => `${t.fired ? "● FIRED" : "○ clear"}  ${t.rule} — ${t.observed}`),
      ...openWindows.slice(0, 3).map(({ e, t }) => `  ↳ ${e.title ?? shortAddr(e.address)} ${t.label}: ${fmtUnits(t.amount, 18, 3)} ETH, closes in ${fmtDuration(t.windowEndsAt - e.oracleTime)}`),
      `Rescue: ${deepLink}`,
    ];
    const message = lines.join("\n");

    const delivered: { channel: string; ok: boolean; status: number | null; error?: string }[] = [];
    if (webhook) {
      try {
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Kestrel-Pager/1.0" },
          // `content` → Discord, `text` → Slack; structured payload for custom receivers
          body: JSON.stringify({ content: message, text: message, kestrel: { triggers, deepLink, base: parity.base, robinhood: parity.robinhood } }),
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        delivered.push({ channel: `webhook ${webhook.hostname}`, ok: res.ok, status: res.status });
      } catch (e) {
        delivered.push({ channel: `webhook ${webhook.hostname}`, ok: false, status: null, error: errMsg(e) });
      }
    }
    if (tgChat) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        delivered.push({ channel: "telegram", ok: false, status: null, error: "TELEGRAM_BOT_TOKEN not configured on server" });
      } else {
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: tgChat, text: message, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(8_000),
          });
          delivered.push({ channel: "telegram", ok: res.ok, status: res.status });
        } catch (e) {
          delivered.push({ channel: "telegram", ok: false, status: null, error: errMsg(e) });
        }
      }
    }
    return json({ triggers, message, deepLink, delivered });
  } catch (e) {
    return apiError(`Pager evaluation failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
