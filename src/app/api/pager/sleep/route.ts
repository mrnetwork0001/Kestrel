/**
 * Sleep Mode (spec §11, §13).
 *
 *   GET    /api/pager/sleep              → { sleep: SleepPublic | null, now, wakeInSec, lastDigest }
 *   POST   /api/pager/sleep              { wakeAt?: ISO | epoch-ms, wakeTime?: "HH:MM", tz?: IANA | "+02:00",
 *                                          tzOffsetMin?: number (minutes EAST of UTC), policy?: "critical-only" | "page-all" }
 *                                        → { sleep, clamped, pendingFirstCheck, snapshotWatches }
 *   DELETE /api/pager/sleep[?digest=1]   → { digest: DigestPayload | null, text, queued, delivered }
 *
 * Auth: `Authorization: Bearer kst_…` (desk key). The snapshot comes from the latest tick state — no RPC calls.
 */
import { apiError, json, preflight } from "@/lib/api";
import { requireDesk } from "@/lib/pager/auth";
import { digestText, finishSleep, recentDigests, sleepPublic, startSleep, type StartSleepInput } from "@/lib/pager/digest";
import { readJsonObject, storeFailure, unknownKeys } from "@/lib/pager/http";
import { limit } from "@/lib/pager/limits";
import { getSleep } from "@/lib/pager/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export function OPTIONS() {
  return preflight();
}

const POST_KEYS = ["wakeAt", "wakeTime", "tz", "tzOffsetMin", "policy"] as const;

export async function GET(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("deskRead", desk.id);
  if (limited) return limited;
  try {
    const [session, digests] = await Promise.all([getSleep(desk.id), recentDigests(desk.id, 1)]);
    const now = Date.now();
    return json({
      sleep: session ? sleepPublic(session) : null,
      now,
      wakeInSec: session ? Math.max(0, Math.round((session.wakeAt - now) / 1000)) : null,
      lastDigest: digests[0] ?? null,
    });
  } catch (e) {
    return storeFailure(e, "sleepStatus");
  }
}

export async function POST(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("sleep", desk.id);
  if (limited) return limited;

  const body = await readJsonObject(req, { maxBytes: 1_024 });
  if (body instanceof Response) return body;
  const unknown = unknownKeys(body, POST_KEYS);
  if (unknown) return unknown;
  if (body.policy !== undefined && body.policy !== "critical-only" && body.policy !== "page-all") {
    return apiError('policy must be "critical-only" or "page-all"', 400);
  }
  if (body.tzOffsetMin !== undefined && (typeof body.tzOffsetMin !== "number" || !Number.isFinite(body.tzOffsetMin))) {
    return apiError("tzOffsetMin must be a number (minutes east of UTC)", 400);
  }
  const input: StartSleepInput = {
    wakeAt: typeof body.wakeAt === "string" || typeof body.wakeAt === "number" ? body.wakeAt : null,
    wakeTime: typeof body.wakeTime === "string" ? body.wakeTime.slice(0, 8) : null,
    tz: typeof body.tz === "string" ? body.tz.slice(0, 64) : null,
    tzOffsetMin: typeof body.tzOffsetMin === "number" ? body.tzOffsetMin : null,
    policy: (body.policy as StartSleepInput["policy"]) ?? null,
  };

  try {
    const r = await startSleep(desk, input);
    if ("error" in r) return apiError(r.error, 400);
    return json({
      sleep: sleepPublic(r.session),
      clamped: r.clamped,
      snapshotWatches: Object.keys(r.session.snapshot).length,
      pendingFirstCheck: r.pendingFirstCheck,
    });
  } catch (e) {
    return storeFailure(e, "startSleep");
  }
}

export async function DELETE(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("sleep", desk.id);
  if (limited) return limited;
  const wantDigest = new URL(req.url).searchParams.get("digest") === "1";

  try {
    const r = await finishSleep(desk.id, { digest: wantDigest });
    if (!r.session) return json({ digest: null, text: null, queued: false, delivered: [], note: "Desk is not sleeping." });
    const note = !r.digest
      ? "Sleep ended without a digest (pass ?digest=1 to get one)."
      : !r.hasChannel
        ? "No delivery channel is linked; the digest is shown here and saved in the desk history."
        : r.queued
          ? "Some channels did not accept the digest yet; the sentinel retries them on the next tick."
          : undefined;
    return json({
      digest: r.digest,
      text: r.digest ? digestText(r.digest) : null,
      delivered: r.delivered,
      queued: r.queued,
      ...(note ? { note } : {}),
    });
  } catch (e) {
    return storeFailure(e, "finishSleep");
  }
}
