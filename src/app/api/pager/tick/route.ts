import { after } from "next/server";
import { apiError, json, preflight } from "@/lib/api";
import { kvSet } from "@/lib/kv";
import { verifySchedulerRequest } from "@/lib/pager/schedule-auth";
import { runTick } from "@/lib/pager/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET|POST /api/pager/tick[?async=1][&dry=1] — one Night-Shift Pager pass (probe → evaluate → commit → deliver → digests).
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron / Schedules, cron-job.org) or a QStash `Upstash-Signature`.
 * Duplicate scheduler deliveries are absorbed by the tick lock (`skipped: "locked"`, HTTP 200 so QStash does not retry)
 * and by the execution id (Vercel `ce-id` / QStash `jti`). `async=1` answers 202 immediately (cron-job.org 30 s timeout).
 * `dry=1` evaluates live state without persisting, delivering or taking the lock.
 */
async function handle(req: Request) {
  const raw = req.method === "POST" ? (await req.text().catch(() => "")).slice(0, 1_048_576) : "";
  const auth = verifySchedulerRequest(req, raw);
  if (!auth.ok) return apiError(auth.reason, 401);
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";

  if (auth.executionId && !dryRun) {
    const fresh = await kvSet(`pager:exec:${auth.executionId}`, "1", { ex: 900, nx: true }).catch(() => true);
    if (!fresh) return json({ skipped: "duplicate", executionId: auth.executionId });
  }

  const opts = { reason: auth.via, executionId: auth.executionId, dryRun } as const;
  if (url.searchParams.get("async") === "1" && !dryRun) {
    after(() => runTick(opts).then(() => undefined, (e) => console.error("[pager] tick failed:", e instanceof Error ? e.message : e)));
    return json({ accepted: true }, { status: 202 });
  }
  try {
    return json(await runTick(opts));
  } catch (e) {
    console.error("[pager] tick failed:", e instanceof Error ? e.message : e);
    return apiError("Tick failed", 500);
  }
}

export const GET = handle;
export const POST = handle; // QStash and Vercel Schedules path targets POST by default
export const OPTIONS = preflight;
