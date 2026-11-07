import { randomBytes } from "node:crypto";
import { apiError, json, preflight } from "@/lib/api";
import { ipHash, requireDesk, storageGuard } from "@/lib/pager/auth";
import { noContent, readJsonObject, storeFailure, unknownKeys } from "@/lib/pager/http";
import { cadenceSec, hit, limit, maxDesksPerIpDay } from "@/lib/pager/limits";
import { SsrfError, assertSafeWebhook } from "@/lib/pager/ssrf";
import {
  createDesk,
  deleteDesk,
  delTgChat,
  getSleep,
  getStatus,
  listWatchViews,
  recentAlerts,
  recentDigests,
  sanitizeLabel,
  toDeskPublic,
  toSleepPublic,
  updateDesk,
} from "@/lib/pager/store";
import type { Desk } from "@/lib/pager/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** Discord / Slack get native payloads; anything else is a generic HMAC-signed JSON receiver. */
function webhookKind(u: URL): "discord" | "slack" | "generic" {
  const host = u.hostname.toLowerCase();
  if (/(^|\.)(discord\.com|discordapp\.com)$/.test(host) && u.pathname.startsWith("/api/webhooks/")) return "discord";
  if (host === "hooks.slack.com") return "slack";
  return "generic";
}

const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

/** Telegram chat ids: numeric (negative for groups/channels) or a public @channel username. */
function parseChatId(raw: string): { chatId: string; chatType: "private" | "group" | "supergroup" | "channel" } | null {
  const v = raw.trim();
  if (/^-100\d{5,16}$/.test(v)) return { chatId: v, chatType: "supergroup" };
  if (/^-\d{1,16}$/.test(v)) return { chatId: v, chatType: "group" };
  if (/^\d{1,16}$/.test(v)) return { chatId: v, chatType: "private" };
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)) return { chatId: v, chatType: "channel" };
  return null;
}

/** POST /api/pager/desk — open an anonymous desk. The desk key is returned exactly once. */
export async function POST(req: Request) {
  const guard = storageGuard();
  if (guard) return guard;
  const ip = ipHash(req);
  const limited = (await limit("deskCreate", ip)) ?? (await limit("deskCreateGlobal", "all"));
  if (limited) return limited;
  const daily = await hit("deskDay", ip, { limit: maxDesksPerIpDay(), windowSec: 86_400 });
  if (daily.limited) return apiError("Too many desks opened from this network today", 429, { retryAfterSec: daily.retryAfterSec });

  const body = await readJsonObject(req, { maxBytes: 2_048, optional: true });
  if (body instanceof Response) return body;
  const bad = unknownKeys(body, ["label"]);
  if (bad) return bad;
  if (body.label !== undefined && body.label !== null && typeof body.label !== "string") return apiError("label must be a string", 400);
  const label = typeof body.label === "string" ? sanitizeLabel(body.label, 60) || null : null;

  try {
    const { deskKey, desk } = await createDesk(label, ip);
    return json(
      {
        deskKey,
        desk: toDeskPublic(desk),
        notice: "Store this desk key now: it is shown once and is the only credential for this desk. Anyone holding it can edit this desk's alerts; it can never touch funds.",
      },
      { status: 201 }
    );
  } catch (e) {
    return storeFailure(e, "createDesk");
  }
}

/** GET /api/pager/desk — the desk with its watches, recent alerts, sleep session and the last tick. */
export async function GET(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("deskRead", desk.id);
  if (limited) return limited;
  try {
    const [watches, alerts, digests, sleep, lastTick] = await Promise.all([
      listWatchViews(desk),
      recentAlerts(desk.id, 20),
      recentDigests(desk.id, 3),
      getSleep(desk.id),
      getStatus(),
    ]);
    return json({
      desk: toDeskPublic(desk, { revealSecret: true }),
      watches,
      recentAlerts: alerts,
      digests,
      sleep: toSleepPublic(sleep),
      cadenceSec: cadenceSec(),
      lastTick,
    });
  } catch (e) {
    return storeFailure(e, "getDesk");
  }
}

/** PATCH /api/pager/desk — label, delivery channels and sleep policy. */
export async function PATCH(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("deskPatch", desk.id);
  if (limited) return limited;

  const body = await readJsonObject(req, { maxBytes: 4_096 });
  if (body instanceof Response) return body;
  const bad = unknownKeys(body, ["label", "webhookUrl", "telegramChatId", "sleepPolicy", "rotateWebhookSecret"]);
  if (bad) return bad;

  // ---- validate everything before touching storage ----
  let label: string | null | undefined;
  if (body.label !== undefined) {
    if (body.label !== null && typeof body.label !== "string") return apiError("label must be a string or null", 400);
    label = typeof body.label === "string" ? sanitizeLabel(body.label, 60) || null : null;
  }

  let webhook: { url: string; kind: "discord" | "slack" | "generic" } | null | undefined;
  if (body.webhookUrl !== undefined) {
    if (body.webhookUrl === null || body.webhookUrl === "") webhook = null;
    else if (typeof body.webhookUrl !== "string") return apiError("webhookUrl must be an https URL string or null", 400);
    else {
      try {
        const u = await assertSafeWebhook(body.webhookUrl.trim());
        webhook = { url: u.toString(), kind: webhookKind(u) };
      } catch (e) {
        return apiError(e instanceof SsrfError ? e.message : "Webhook URL rejected", 400);
      }
    }
  }

  let telegram: ReturnType<typeof parseChatId> | undefined;
  if (body.telegramChatId !== undefined) {
    if (body.telegramChatId === null || body.telegramChatId === "") telegram = null;
    else {
      const raw = typeof body.telegramChatId === "number" && Number.isSafeInteger(body.telegramChatId) ? String(body.telegramChatId) : body.telegramChatId;
      if (typeof raw !== "string") return apiError("telegramChatId must be a string, number or null", 400);
      telegram = parseChatId(raw);
      if (!telegram) return apiError("telegramChatId must be a numeric chat id (e.g. 123456789 or -100…) or an @channel username", 400);
    }
  }

  let sleepPolicy: Desk["policy"]["sleepMode"] | undefined;
  if (body.sleepPolicy !== undefined) {
    if (body.sleepPolicy !== "critical-only" && body.sleepPolicy !== "page-all") return apiError('sleepPolicy must be "critical-only" or "page-all"', 400);
    sleepPolicy = body.sleepPolicy;
  }

  if (body.rotateWebhookSecret !== undefined && body.rotateWebhookSecret !== true) return apiError("rotateWebhookSecret must be true when present", 400);
  const rotate = body.rotateWebhookSecret === true;

  // ---- apply under the desk lock ----
  let issuedSecret: string | null = null;
  let droppedChat: string | null = null;
  try {
    const next = await updateDesk(desk.id, (d) => {
      if (label !== undefined) d.label = label;
      if (sleepPolicy) d.policy = { ...d.policy, sleepMode: sleepPolicy };
      if (webhook === null) d.channels.webhook = null;
      else if (webhook) {
        const prev = d.channels.webhook;
        const keepSecret = prev && !rotate ? prev.secret : null;
        const secret = keepSecret ?? newWebhookSecret();
        if (!keepSecret) issuedSecret = secret;
        d.channels.webhook = { url: webhook.url, kind: webhook.kind, secret, addedAt: Date.now(), failures: 0, disabledReason: null };
      }
      if (rotate && webhook === undefined) {
        if (!d.channels.webhook) throw new PatchError("No webhook configured to rotate a secret for");
        issuedSecret = newWebhookSecret();
        d.channels.webhook = { ...d.channels.webhook, secret: issuedSecret };
      }
      if (telegram !== undefined) {
        const prev = d.channels.telegram;
        if (prev?.verified && prev.chatId !== telegram?.chatId) droppedChat = prev.chatId;
        d.channels.telegram = telegram
          ? { chatId: telegram.chatId, username: null, chatType: telegram.chatType, linkedAt: Date.now(), verified: false, disabledReason: null }
          : null;
      }
    });
    if (!next) return apiError("Desk not found (it may have been deleted)", 404);
    if (droppedChat) await delTgChat(droppedChat, desk.id).catch(() => undefined);
    const showSecret = !!issuedSecret && next.channels.webhook?.kind === "generic";
    // A typed chat id is stored as a PENDING link: Kestrel never messages it until that chat presses Start on the
    // bot through this desk's POST /api/pager/telegram/link deep link (then it becomes verified).
    const telegramNote = telegram
      ? "Chat id saved as UNVERIFIED: Kestrel will not send pages to it until the chat presses Start via this desk's link (POST /api/pager/telegram/link)."
      : undefined;
    return json({ desk: toDeskPublic(next, { revealSecret: true }), ...(showSecret ? { webhookSecret: issuedSecret } : {}), ...(telegramNote ? { telegramNote } : {}) });
  } catch (e) {
    if (e instanceof PatchError) return apiError(e.message, 400);
    return storeFailure(e, "patchDesk");
  }
}

class PatchError extends Error {}

/** DELETE /api/pager/desk — removes the desk, its watches, states, sleep session, alert history and pending deliveries. */
export async function DELETE(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("deskDelete", desk.id);
  if (limited) return limited;
  try {
    await deleteDesk(desk.id);
    return noContent();
  } catch (e) {
    return storeFailure(e, "deleteDesk");
  }
}
