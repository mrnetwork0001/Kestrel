import { apiError, json } from "@/lib/api";
import { safeEqual } from "@/lib/pager/schedule-auth";
import { handleUpdate, type TgUpdate } from "@/lib/pager/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/pager/telegram/webhook — Telegram Bot API updates (webhook mode).
 * Enabled only when TELEGRAM_WEBHOOK_SECRET is set and `setWebhook … secret_token=$TELEGRAM_WEBHOOK_SECRET` was run;
 * every request must carry the matching `X-Telegram-Bot-Api-Secret-Token`. After that check it always answers 200
 * so Telegram never re-delivers an update we already processed.
 */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return apiError("Telegram webhook mode not configured", 404);
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!got || !safeEqual(got, secret)) return apiError("Forbidden", 403);
  let update: TgUpdate | null = null;
  try {
    const text = await req.text();
    if (text.length <= 65_536) update = JSON.parse(text) as TgUpdate;
  } catch {
    update = null;
  }
  if (update && typeof update.update_id === "number") await handleUpdate(update);
  return json({});
}
