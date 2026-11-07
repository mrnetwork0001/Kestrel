import { apiError, json, preflight, rateLimited } from "@/lib/api";
import { CONTRACTS } from "@/config/contracts";
import { errMsg, normalizeChainId, parseAddress } from "@/lib/engine/chain-utils";
import { readAllEscrows } from "@/lib/engine/escrow";
import { getBridgeParity } from "@/lib/engine/parity";
import { readPool } from "@/lib/engine/pools";
import { fmtBps, fmtDuration, fmtUnits, shortAddr } from "@/lib/format";
import { deliverTelegram, deliverWebhook } from "@/lib/pager/deliver";
import { absUrl, rescueHref } from "@/lib/pager/links";
import { renderNotice } from "@/lib/pager/render";
import { assertSafeWebhook } from "@/lib/pager/ssrf";
import { getTgChat } from "@/lib/pager/store";
import { tgBotUsername, tgConfigured } from "@/lib/pager/telegram";

export const runtime = "nodejs";
export const maxDuration = 45;

interface Body {
  webhookUrl?: string;
  telegramChatId?: string;
  target?: string;
  chainId?: number;
  rules?: { lpDropPct?: number; maxSpreadBps?: number; watchChallengeWindows?: boolean; parityDrift?: boolean };
}

/**
 * POST /api/pager/test — evaluates the user's armed rules against LIVE chain state and dispatches a
 * real Night-Shift Pager alert (webhook and/or Telegram) with a 1-click /rescue deep link.
 * Webhooks go through the shared SSRF guard (re-checked and IP-pinned at send time). Telegram only delivers to a
 * chat that has linked itself via the bot's /start deep link, so the bot cannot be used to message strangers.
 * With no destination the response carries `dryRun: true` (nothing was sent).
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

    // Canonical origin only (never the request Host); /rescue is the Base Panic Bunker.
    const rescuePath = rescueHref(chainId === 8453 ? target : null);
    const deepLink = absUrl(rescuePath);
    const fired = triggers.filter((t) => t.fired);
    const lines = [
      `>_ KESTREL NIGHT-SHIFT PAGER · TEST`,
      `${fired.length ? `${fired.length} rule(s) FIRED` : "All armed rules clear"} · Base #${BigInt(parity.base.number).toLocaleString("en-US")} · RH #${BigInt(parity.robinhood.number).toLocaleString("en-US")}`,
      ...triggers.map((t) => `${t.fired ? "● FIRED" : "○ clear"}  ${t.rule} — ${t.observed}`),
      ...openWindows.slice(0, 3).map(({ e, t }) => `  ↳ ${e.title ?? shortAddr(e.address)} ${t.label}: ${fmtUnits(t.amount, 18, 3)} ETH, closes in ${fmtDuration(t.windowEndsAt - e.oracleTime)}`),
      `Rescue: ${deepLink}`,
    ];
    const message = lines.join("\n");

    // Same message, rendered per channel (Telegram HTML / Discord / Slack / generic JSON) with escaping.
    const rendered = renderNotice({
      event: "test",
      severity: fired.length ? "warn" : "info",
      headline: lines[0],
      lines: lines.slice(1, -1),
      links: [{ label: "Open Panic Bunker", href: rescuePath }],
      data: { triggers, deepLink, base: parity.base, robinhood: parity.robinhood },
    });
    const deliveryId = `test:${Date.now().toString(36)}`;

    const delivered: { channel: string; ok: boolean; status: number | null; error?: string }[] = [];
    if (webhook) {
      const d = await deliverWebhook({ url: webhook.toString() }, rendered, { deliveryId });
      delivered.push({ channel: d.target, ok: d.ok, status: d.status, ...(d.error ? { error: d.error } : {}) });
    }
    if (tgChat) {
      if (!tgConfigured()) {
        delivered.push({ channel: "telegram", ok: false, status: null, error: "TELEGRAM_BOT_TOKEN not configured on server" });
      } else if (!(await getTgChat(tgChat).catch(() => null))) {
        const bot = await tgBotUsername().catch(() => null);
        delivered.push({
          channel: "telegram",
          ok: false,
          status: null,
          error: `Chat not linked. Open a desk in the Night-Shift Pager and press LINK TELEGRAM${bot ? ` (t.me/${bot})` : ""}; Kestrel only messages chats that started the bot through a link.`,
        });
      } else {
        const d = await deliverTelegram(tgChat, rendered);
        delivered.push({ channel: "telegram", ok: d.ok, status: d.status, ...(d.error ? { error: d.error } : {}) });
      }
    }
    return json({ triggers, message, deepLink, delivered, ...(!webhook && !tgChat ? { dryRun: true } : {}) });
  } catch (e) {
    return apiError(`Pager evaluation failed: ${errMsg(e)}`, 502);
  }
}

export const OPTIONS = preflight;
