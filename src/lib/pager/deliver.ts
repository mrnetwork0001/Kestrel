/**
 * Night-Shift Pager delivery: Telegram (HTML, silent unless CRITICAL) and one webhook per desk
 * (Discord / Slack native payloads, HMAC-signed generic JSON for agents and custom receivers).
 *
 * Every webhook send re-runs the SSRF guard and pins the TCP connection to the vetted IP (`safeRequest`), never
 * follows redirects, and caps time (8 s) and response size. Outcomes are returned, never thrown; the caller
 * (tick / sleep route) persists channel health via `applyDeliveryOutcomes`.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Desk, OutboxItem } from "@/lib/pager/types";
import { renderAlerts, renderDigest, type Rendered } from "@/lib/pager/render";
import { SsrfError, assertSafeUrlShape, safeRequest } from "@/lib/pager/ssrf";
import { tgFatalReason, tgSend } from "@/lib/pager/telegram";

export type ChannelName = "telegram" | "webhook";

export interface Delivery {
  channel: ChannelName;
  /** Display-safe destination: "telegram" / webhook host. Never the full webhook URL (it is a credential). */
  target: string;
  ok: boolean;
  status: number | null;
  error?: string;
  /** Seconds to wait before retrying (Telegram 429 / Discord 429). */
  retryAfter?: number;
  /** Telegram group upgraded to a supergroup: new chat id. */
  migrateTo?: string;
  /** Permanent failure: disable the channel with this reason. */
  disable?: string;
  durationMs?: number;
}

export type WebhookKind = "discord" | "slack" | "generic";

const WEBHOOK_DISABLE_AFTER = 10;

/** Discord: discord.com|discordapp.com + /api/webhooks/; Slack: hooks.slack.com; else generic. */
export function detectWebhookKind(url: string | URL): WebhookKind {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return "generic";
  }
  const h = u.hostname.toLowerCase();
  if (/(^|\.)(discord\.com|discordapp\.com)$/.test(h) && u.pathname.startsWith("/api/webhooks/")) return "discord";
  if (h === "hooks.slack.com") return "slack";
  return "generic";
}

/** 32 random bytes, hex — the per-desk HMAC key for generic webhooks. */
export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString("hex")}`;

/** `sha256=<hex>` HMAC over the exact raw body bytes. Receivers recompute and compare in constant time. */
export const signBody = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "webhook";
  }
};

/** Sends a rendered message to a Telegram chat. */
export async function deliverTelegram(chatId: string, r: Rendered): Promise<Delivery> {
  const started = Date.now();
  const res = await tgSend(chatId, r.html, r.buttons, r.silent, r.plain);
  if (res.ok) return { channel: "telegram", target: "telegram", ok: true, status: res.status, durationMs: Date.now() - started };
  return {
    channel: "telegram",
    target: "telegram",
    ok: false,
    status: res.status,
    error: res.error,
    retryAfter: res.retryAfter,
    migrateTo: res.migrateTo,
    disable: tgFatalReason(res) ?? undefined,
    durationMs: Date.now() - started,
  };
}

/**
 * Sends a rendered message to a webhook. `secret` signs generic payloads (X-Kestrel-Signature).
 * `deliveryId` is stable across retries so receivers can dedupe (X-Kestrel-Delivery).
 */
export async function deliverWebhook(hook: { url: string; kind?: WebhookKind; secret?: string | null }, r: Rendered, meta: { deliveryId: string }): Promise<Delivery> {
  const kind = hook.kind ?? detectWebhookKind(hook.url);
  const target = `${kind === "generic" ? "webhook" : kind} ${hostOf(hook.url)}`;
  let url = hook.url;
  let body: string;
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Kestrel-Pager/1.0" };
  if (kind === "discord") {
    const u = new URL(hook.url);
    u.searchParams.set("wait", "true");
    if ((r.discord as { components?: unknown }).components) u.searchParams.set("with_components", "true");
    url = u.toString();
    body = JSON.stringify(r.discord);
  } else if (kind === "slack") {
    body = JSON.stringify(r.slack);
  } else {
    body = JSON.stringify({ ...r.generic, kestrel: { ...r.generic.kestrel, deliveryId: meta.deliveryId, sentAt: new Date().toISOString() } });
    headers["X-Kestrel-Event"] = r.event;
    headers["X-Kestrel-Delivery"] = meta.deliveryId.slice(0, 128);
    if (hook.secret) headers["X-Kestrel-Signature"] = signBody(hook.secret, body);
  }
  try {
    const res = await safeRequest(url, { method: "POST", headers, body, timeoutMs: 8_000, maxBytes: 16_384 });
    if (res.ok) return { channel: "webhook", target, ok: true, status: res.status, durationMs: res.durationMs };
    const ra = Number(res.headers["retry-after"]);
    const snippet = res.text.replace(/\s+/g, " ").trim().slice(0, 160);
    const gone = res.status === 404 || res.status === 410 || (kind === "slack" && /no_service|channel_not_found|channel_is_archived|invalid_token/.test(res.text));
    return {
      channel: "webhook",
      target,
      ok: false,
      status: res.status,
      error: res.status >= 300 && res.status < 400 ? `HTTP ${res.status} redirect (not followed)` : `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
      retryAfter: Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined,
      disable: gone ? `Webhook returned HTTP ${res.status} (deleted or revoked)` : undefined,
      durationMs: res.durationMs,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { channel: "webhook", target, ok: false, status: null, error: msg.slice(0, 200), disable: e instanceof SsrfError && !e.transient ? `Blocked by SSRF guard: ${msg}` : undefined };
  }
}

/** Active channels on a desk (not disabled). */
export function activeChannels(desk: Desk): { telegram: boolean; webhook: boolean } {
  return {
    telegram: !!desk.channels.telegram && !desk.channels.telegram.disabledReason,
    webhook: !!desk.channels.webhook && !desk.channels.webhook.disabledReason,
  };
}

/** Sends `r` to every active channel of the desk (or the subset in `only`). */
export async function deliver(desk: Desk, r: Rendered, opts: { deliveryId: string; only?: Partial<Record<ChannelName, boolean>> }): Promise<Delivery[]> {
  const act = activeChannels(desk);
  const want = (c: ChannelName) => act[c] && (opts.only ? !!opts.only[c] : true);
  const jobs: Promise<Delivery>[] = [];
  if (want("telegram")) jobs.push(deliverTelegram(desk.channels.telegram!.chatId, r));
  if (want("webhook")) {
    const w = desk.channels.webhook!;
    jobs.push(deliverWebhook({ url: w.url, kind: w.kind, secret: w.secret }, r, { deliveryId: opts.deliveryId }));
  }
  return Promise.all(jobs);
}

/** Renders an outbox item for delivery (alerts → one message per desk; digest → While You Slept). */
export function renderOutboxItem(desk: Desk, item: OutboxItem, opts: { wokeYou?: boolean; labels?: Record<string, string> } = {}): Rendered | null {
  if (item.kind === "digest") return item.digest ? renderDigest(desk, item.digest) : null;
  if (!item.alerts.length) return null;
  return renderAlerts(desk, item.alerts, opts);
}

/**
 * Delivers the channels of an outbox item that are still pending/failed. Returns the deliveries and the
 * item's next status (channels that succeeded become "sent" and are never re-sent).
 */
export async function deliverOutboxItem(desk: Desk, item: OutboxItem, opts: { labels?: Record<string, string> } = {}): Promise<{ deliveries: Delivery[]; status: OutboxItem["status"]; done: boolean }> {
  const status = { ...item.status };
  const act = activeChannels(desk);
  // channels that were removed/disabled since queuing are dropped from the item
  if (status.telegram && status.telegram !== "sent" && !act.telegram) delete status.telegram;
  if (status.webhook && status.webhook !== "sent" && !act.webhook) delete status.webhook;
  const only = { telegram: status.telegram === "pending" || status.telegram === "failed", webhook: status.webhook === "pending" || status.webhook === "failed" };
  const r = renderOutboxItem(desk, item, opts);
  if (!r || (!only.telegram && !only.webhook)) return { deliveries: [], status, done: true };
  const deliveries = await deliver(desk, r, { deliveryId: item.id, only });
  for (const d of deliveries) status[d.channel] = d.ok ? "sent" : d.disable ? undefined : "failed";
  for (const c of ["telegram", "webhook"] as const) if (status[c] === undefined) delete status[c];
  const done = !Object.values(status).some((s) => s === "pending" || s === "failed");
  return { deliveries, status, done };
}

/**
 * Applies delivery outcomes to the desk's channel health: resets webhook failures on success, counts
 * consecutive failures (disable after 10), disables on permanent errors, follows Telegram chat migrations.
 * Returns the updated desk and whether it changed (persist with store.putDesk when changed).
 */
export function applyDeliveryOutcomes(desk: Desk, deliveries: Delivery[]): { desk: Desk; changed: boolean } {
  let next = desk;
  let changed = false;
  for (const d of deliveries) {
    if (d.channel === "webhook" && next.channels.webhook) {
      const w = next.channels.webhook;
      const failures = d.ok ? 0 : w.failures + 1;
      const disabledReason = d.disable ?? (failures >= WEBHOOK_DISABLE_AFTER ? `Disabled after ${failures} consecutive failures (last: ${d.error ?? "error"})`.slice(0, 200) : w.disabledReason);
      if (failures !== w.failures || disabledReason !== w.disabledReason) {
        next = { ...next, channels: { ...next.channels, webhook: { ...w, failures, disabledReason } } };
        changed = true;
      }
    }
    if (d.channel === "telegram" && next.channels.telegram) {
      const t = next.channels.telegram;
      if (d.migrateTo && d.migrateTo !== t.chatId) {
        next = { ...next, channels: { ...next.channels, telegram: { ...t, chatId: d.migrateTo, chatType: "supergroup" } } };
        changed = true;
      } else if (d.disable && t.disabledReason !== d.disable) {
        next = { ...next, channels: { ...next.channels, telegram: { ...t, disabledReason: d.disable.slice(0, 200) } } };
        changed = true;
      }
    }
  }
  return { desk: next, changed };
}

/** Validates a webhook URL's shape for config endpoints (DNS is checked again on every send). */
export function validateWebhookUrl(raw: string): { url: string; kind: WebhookKind } {
  const u = assertSafeUrlShape(raw);
  return { url: u.toString(), kind: detectWebhookKind(u) };
}
