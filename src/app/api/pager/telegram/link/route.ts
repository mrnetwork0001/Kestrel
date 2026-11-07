import { apiError, json, preflight } from "@/lib/api";
import { requireDesk } from "@/lib/pager/auth";
import { noContent, storeFailure } from "@/lib/pager/http";
import { limit } from "@/lib/pager/limits";
import { getDesk } from "@/lib/pager/store";
import { createLinkToken, linkStatus, pollTelegramUpdates, tgConfigured, tgMode, unlinkTelegram } from "@/lib/pager/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/pager/telegram/link — single-use deep link `https://t.me/<bot>?start=<token>` (15 min) for this desk.
 * GET — link status for the UI poller ("linked" | "pending" | "none" | "expired"). In polling mode (no webhook) this
 *       drains getUpdates first, so linking works on localhost and before `setWebhook`.
 * DELETE — unlink the desk's Telegram chat.
 * Auth: `Authorization: Bearer kst_…` (desk key).
 */
export async function POST(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("tgLinkCreate", desk.id);
  if (limited) return limited;
  if (!tgConfigured()) return apiError("Telegram is not configured on this server (TELEGRAM_BOT_TOKEN). Use a webhook instead.", 503);
  try {
    const t = await createLinkToken(desk.id);
    return json({ url: t.url, expiresAt: t.expiresAt, mode: t.mode, bot: t.bot });
  } catch (e) {
    if (e instanceof Error && /Telegram|TELEGRAM/.test(e.message)) return apiError(e.message, 503);
    return storeFailure(e, "telegram link create");
  }
}

export async function GET(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("tgLinkPoll", desk.id);
  if (limited) return limited;
  try {
    let poll: Awaited<ReturnType<typeof pollTelegramUpdates>> | null = null;
    let current = desk;
    if (tgConfigured() && tgMode() === "polling") {
      poll = await pollTelegramUpdates({ maxBatches: 2 });
      if (poll.processed) current = (await getDesk(desk.id)) ?? desk;
    }
    const st = await linkStatus(current);
    const t = current.channels.telegram;
    return json({
      status: st.status,
      ...(st.expiresAt ? { expiresAt: st.expiresAt } : {}),
      mode: tgMode(),
      configured: tgConfigured(),
      ...(t ? { telegram: { username: t.username, chatType: t.chatType, verified: t.verified, disabledReason: t.disabledReason, linkedAt: t.linkedAt } } : {}),
      ...(poll?.error ? { pollError: poll.error } : {}),
    });
  } catch (e) {
    return storeFailure(e, "telegram link status");
  }
}

export async function DELETE(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("tgLinkDelete", desk.id);
  if (limited) return limited;
  try {
    await unlinkTelegram(desk);
    return noContent();
  } catch (e) {
    return storeFailure(e, "telegram unlink");
  }
}

export const OPTIONS = preflight;
