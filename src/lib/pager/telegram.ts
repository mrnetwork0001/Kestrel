/**
 * Telegram Bot API wrapper + deep-link chat linking (spec §10.2, §12).
 *
 * Linking: POST /api/pager/telegram/link creates a single-use token (`tl` + 20 base64url chars, 15 min TTL) →
 * `https://t.me/<bot>?start=<token>`. When the user presses Start the bot receives `/start <token>`:
 *   - webhook mode (TELEGRAM_WEBHOOK_SECRET set + setWebhook done): /api/pager/telegram/webhook processes it;
 *   - polling mode (no webhook; works on localhost): getUpdates is polled by GET /api/pager/telegram/link and by
 *     every tick, processing ALL pending updates (idempotent across instances; offset kept in KV).
 * A chat is only ever bound through a /start token the bot actually received, so the bot cannot be pointed
 * at a stranger's chat (audit `pager-relay-abuse`). Manual chat ids remain possible as `verified: false`.
 *
 * The bot token is part of every Bot API URL: it is never logged, and errors never include the URL.
 */
import { randomBytes } from "node:crypto";
import { kvDel, kvGet, kvSet } from "@/lib/kv";
import { createTgLink, delTgChat, getTgChat, getTgOffset, setTgChat, setTgOffset, takeTgLink, updateDesk } from "@/lib/pager/store";
import { absUrl, pagerHref } from "@/lib/pager/links";
import type { Desk } from "@/lib/pager/types";

export { escHtml } from "@/lib/pager/render";

const API = "https://api.telegram.org";
const LINK_TTL_SEC = 900;
/** Keys owned by this module (link tokens, chat index and offset live in store.ts). */
const K = {
  pending: (deskId: string) => `pager:tgpending:${deskId}`,
  pollLock: "pager:tgpoll:lock",
  botName: "pager:tgbot",
};

export const LINK_TOKEN_RE = /^tl[A-Za-z0-9_-]{10,62}$/;
const START_RE = /^\/start(?:@\w+)?\s+(tl[A-Za-z0-9_-]{10,62})\s*$/;

export type TgMode = "webhook" | "polling";

export const tgConfigured = (): boolean => !!process.env.TELEGRAM_BOT_TOKEN;
/** Webhook mode iff a webhook secret is configured (setWebhook must have been run with the same secret). */
export const tgMode = (): TgMode => (process.env.TELEGRAM_WEBHOOK_SECRET ? "webhook" : "polling");

export type TgResult =
  | { ok: true; status: number; messageId?: number }
  | { ok: false; status: number | null; error: string; retryAfter?: number; migrateTo?: string };

interface TgEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Low-level Bot API call. Never throws; never exposes the token. */
async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 8_000): Promise<{ status: number | null; env: TgEnvelope<T> }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { status: null, env: { ok: false, description: "TELEGRAM_BOT_TOKEN not configured on server" } };
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const env = ((await res.json().catch(() => ({}))) ?? {}) as TgEnvelope<T>;
    return { status: res.status, env };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { status: null, env: { ok: false, description: timeout ? "Telegram API timed out" : "Telegram API network error" } };
  }
}

/**
 * sendMessage with parse_mode HTML. `silent` → disable_notification (warnings arrive quietly; only CRITICAL rings).
 * If Telegram rejects the HTML entities, retries once as plain text so a page is never lost to markup.
 */
export async function tgSend(chatId: string, html: string, buttons: { text: string; url: string }[][], silent: boolean, plainFallback?: string): Promise<TgResult> {
  const plainBase = { chat_id: chatId, link_preview_options: { is_disabled: true }, disable_notification: silent };
  const base = { ...plainBase, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) };
  let r = await call<{ message_id: number }>("sendMessage", { ...base, text: html, parse_mode: "HTML" });
  if (!r.env.ok && r.status === 400 && plainFallback && /parse entities|can't find end|unsupported start tag/i.test(r.env.description ?? "")) {
    r = await call<{ message_id: number }>("sendMessage", { ...base, text: plainFallback });
  }
  if (!r.env.ok && r.status === 400 && buttons.length && /button|URL|url/i.test(r.env.description ?? "")) {
    // e.g. "BUTTON_URL_INVALID" / "wrong HTTP URL": drop the keyboard rather than the page
    r = await call<{ message_id: number }>("sendMessage", { ...plainBase, text: html, parse_mode: "HTML" });
  }
  if (r.env.ok) return { ok: true, status: r.status ?? 200, messageId: r.env.result?.message_id };
  return {
    ok: false,
    status: r.status,
    error: (r.env.description ?? `HTTP ${r.status ?? "?"}`).slice(0, 200),
    retryAfter: r.env.parameters?.retry_after,
    migrateTo: r.env.parameters?.migrate_to_chat_id !== undefined ? String(r.env.parameters.migrate_to_chat_id) : undefined,
  };
}

/** Errors after which a chat should be disabled (surfaced in the UI as disabledReason). */
export function tgFatalReason(r: TgResult): string | null {
  if (r.ok) return null;
  const d = r.error.toLowerCase();
  if (r.status === 403 || /blocked|kicked|deactivated|not a member|have no rights|not enough rights/.test(d)) return `Telegram: ${r.error}`;
  if (r.status === 400 && /chat not found|chat_id is empty|peer_id_invalid|group chat was upgraded/.test(d) && !r.migrateTo) return `Telegram: ${r.error}`;
  return null;
}

/* ------------------------------------------------------------------ bot identity */

const g = globalThis as typeof globalThis & { __kestrelTgBot?: { name: string | null; at: number } };

/** Bot username for t.me links: TELEGRAM_BOT_USERNAME, else getMe (cached 1 h in-process and 1 day in KV). */
export async function tgBotUsername(): Promise<string | null> {
  const env = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "").trim();
  if (env && /^[A-Za-z0-9_]{3,64}$/.test(env)) return env;
  if (!tgConfigured()) return null;
  const c = g.__kestrelTgBot;
  if (c && Date.now() - c.at < 3_600_000 && c.name) return c.name;
  const cachedName = await kvGet(K.botName);
  if (cachedName && /^[A-Za-z0-9_]{3,64}$/.test(cachedName)) {
    g.__kestrelTgBot = { name: cachedName, at: Date.now() };
    return cachedName;
  }
  const r = await call<{ username?: string }>("getMe", {});
  const name = r.env.ok && r.env.result?.username && /^[A-Za-z0-9_]{3,64}$/.test(r.env.result.username) ? r.env.result.username : null;
  g.__kestrelTgBot = { name, at: Date.now() };
  if (name) await kvSet(K.botName, name, { ex: 86_400 }).catch(() => undefined);
  return name;
}

/* ------------------------------------------------------------------ linking */

export interface LinkTicket {
  url: string;
  token: string;
  expiresAt: number;
  mode: TgMode;
  bot: string;
}

/** Creates a single-use deep-link token for `deskId`. Throws if Telegram is not configured. */
export async function createLinkToken(deskId: string): Promise<LinkTicket> {
  const bot = await tgBotUsername();
  if (!bot) throw new Error(tgConfigured() ? "Telegram bot username unavailable (set TELEGRAM_BOT_USERNAME)" : "TELEGRAM_BOT_TOKEN not configured on server");
  const token = `tl${randomBytes(15).toString("base64url")}`; // 2 + 20 chars, well under Telegram's 64
  const expiresAt = Date.now() + LINK_TTL_SEC * 1000;
  await createTgLink(token, deskId, LINK_TTL_SEC);
  await kvSet(K.pending(deskId), JSON.stringify({ token, expiresAt }), { ex: LINK_TTL_SEC + 3_600 });
  return { url: `https://t.me/${bot}?start=${token}`, token, expiresAt, mode: tgMode(), bot };
}

export type LinkStatus = "linked" | "pending" | "none" | "expired";

/** Link status for the UI poller: a pending token wins (re-link in progress), else the desk's channel. */
export async function linkStatus(desk: Desk): Promise<{ status: LinkStatus; expiresAt?: number }> {
  const raw = await kvGet(K.pending(desk.id));
  let pending: { token: string; expiresAt: number } | null = null;
  try {
    pending = raw ? (JSON.parse(raw) as { token: string; expiresAt: number }) : null;
  } catch {
    pending = null;
  }
  if (pending && typeof pending.expiresAt === "number") {
    return pending.expiresAt > Date.now() ? { status: "pending", expiresAt: pending.expiresAt } : { status: "expired", expiresAt: pending.expiresAt };
  }
  return { status: desk.channels.telegram ? "linked" : "none" };
}

/** Removes the Telegram channel from the desk (and the reverse index). */
export async function unlinkTelegram(desk: Desk): Promise<Desk> {
  const t = desk.channels.telegram;
  if (t) await delTgChat(t.chatId, desk.id).catch(() => undefined);
  await kvDel(K.pending(desk.id)).catch(() => 0);
  const next = await updateDesk(desk.id, (d) => {
    d.channels.telegram = null;
  });
  return next ?? { ...desk, channels: { ...desk.channels, telegram: null } };
}

/* ------------------------------------------------------------------ updates */

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  title?: string;
  first_name?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: TgChat; from?: { id: number; username?: string; is_bot?: boolean }; text?: string; migrate_to_chat_id?: number };
  channel_post?: { message_id: number; chat: TgChat; text?: string };
  my_chat_member?: { chat: TgChat; new_chat_member?: { status?: string } };
}

const reply = (chatId: number | string, text: string) =>
  call("sendMessage", { chat_id: String(chatId), text, link_preview_options: { is_disabled: true } }).then(() => undefined);

async function bindChat(token: string, chat: TgChat, username: string | null): Promise<"linked" | "invalid"> {
  const deskId = await takeTgLink(token); // GETDEL: single use, race-free across instances
  if (!deskId) return "invalid";
  const chatId = String(chat.id);
  const prev = await updateDesk(deskId, (d) => {
    const old = d.channels.telegram;
    if (old && old.chatId !== chatId) void delTgChat(old.chatId, deskId).catch(() => undefined);
    d.channels.telegram = { chatId, username: chat.username ?? username, chatType: chat.type, linkedAt: Date.now(), verified: true, disabledReason: null };
  });
  if (!prev) return "invalid";
  await setTgChat(chatId, deskId).catch(() => undefined);
  await kvDel(K.pending(deskId)).catch(() => 0);
  return "linked";
}

/** Disables (or migrates) the desk bound to `chatId` via the reverse index. Returns the number of desks updated. */
export async function disableChat(chatId: string, reason: string, migrateTo?: string): Promise<number> {
  const deskId = await getTgChat(chatId);
  if (!deskId) return 0;
  let changed = false;
  await updateDesk(deskId, (d) => {
    const t = d.channels.telegram;
    if (!t || t.chatId !== chatId) return null;
    d.channels.telegram = migrateTo ? { ...t, chatId: migrateTo, chatType: "supergroup", disabledReason: null } : { ...t, disabledReason: reason.slice(0, 200) };
    changed = true;
  });
  if (migrateTo && changed) {
    await setTgChat(migrateTo, deskId).catch(() => undefined);
    await delTgChat(chatId, deskId).catch(() => undefined);
  }
  return changed ? 1 : 0;
}

/** Processes one Telegram update (webhook or polling). Never throws. */
export async function handleUpdate(u: TgUpdate): Promise<{ action: "linked" | "invalid-token" | "disabled" | "migrated" | "help" | "ignored" }> {
  try {
    const msg = u.message ?? u.channel_post;
    if (u.message?.migrate_to_chat_id) {
      await disableChat(String(u.message.chat.id), "", String(u.message.migrate_to_chat_id));
      return { action: "migrated" };
    }
    if (u.my_chat_member) {
      const st = u.my_chat_member.new_chat_member?.status;
      if (st === "kicked" || st === "left") {
        await disableChat(String(u.my_chat_member.chat.id), `Telegram: bot was ${st === "kicked" ? "blocked/removed" : "removed"} from this chat`);
        return { action: "disabled" };
      }
      return { action: "ignored" };
    }
    const text = msg?.text?.trim();
    if (!msg || !text || u.message?.from?.is_bot) return { action: "ignored" };
    const m = START_RE.exec(text);
    if (m) {
      const r = await bindChat(m[1], msg.chat, u.message?.from?.username ?? null);
      if (r === "linked") {
        await reply(msg.chat.id, "Linked to your Kestrel desk ✓\nCRITICAL pages ring; warnings arrive silently. Stay asleep: Kestrel watches the chain.");
        return { action: "linked" };
      }
      await reply(msg.chat.id, `This Kestrel link has expired or was already used. Open ${absUrl(pagerHref())} and press LINK TELEGRAM again.`);
      return { action: "invalid-token" };
    }
    if (/^\/(start|help)(@\w+)?$/.test(text)) {
      await reply(msg.chat.id, `Kestrel Night-Shift Pager. To link this chat, open ${absUrl(pagerHref())} → Night-Shift Pager → LINK TELEGRAM and tap the link it gives you.`);
      return { action: "help" };
    }
    return { action: "ignored" };
  } catch (e) {
    console.warn(`[pager] telegram update ${u.update_id} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { action: "ignored" };
  }
}

/**
 * Polling mode: drains getUpdates (timeout 0) and processes every update. A short KV lock keeps concurrent
 * pollers from double-processing; the stored offset acknowledges processed updates. No-op in webhook mode.
 */
export async function pollTelegramUpdates(opts: { maxBatches?: number } = {}): Promise<{ processed: number; linked: number; error?: string; skipped?: string }> {
  if (!tgConfigured()) return { processed: 0, linked: 0, skipped: "not-configured" };
  if (tgMode() === "webhook") return { processed: 0, linked: 0, skipped: "webhook-mode" };
  const got = await kvSet(K.pollLock, String(Date.now()), { ex: 10, nx: true }).catch(() => false);
  if (!got) return { processed: 0, linked: 0, skipped: "busy" };
  let processed = 0;
  let linked = 0;
  try {
    let offset = (await getTgOffset()) ?? 0;
    for (let i = 0; i < (opts.maxBatches ?? 3); i++) {
      const r = await call<TgUpdate[]>("getUpdates", { offset: offset || undefined, timeout: 0, limit: 100, allowed_updates: ["message", "my_chat_member", "channel_post"] }, 6_000);
      if (!r.env.ok) {
        // 409: a webhook is set on Telegram's side — getUpdates and webhooks are mutually exclusive
        return { processed, linked, error: r.status === 409 ? "Telegram webhook is set; configure TELEGRAM_WEBHOOK_SECRET to use webhook mode" : (r.env.description ?? "getUpdates failed").slice(0, 160) };
      }
      const updates = Array.isArray(r.env.result) ? r.env.result : [];
      if (!updates.length) break;
      for (const u of updates) {
        const res = await handleUpdate(u);
        processed++;
        if (res.action === "linked") linked++;
        offset = Math.max(offset, u.update_id + 1);
      }
      await setTgOffset(offset);
      if (updates.length < 100) break;
    }
    return { processed, linked };
  } finally {
    await kvDel(K.pollLock).catch(() => 0);
  }
}
