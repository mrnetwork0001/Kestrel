import { apiError, json, preflight } from "@/lib/api";
import { requireDesk } from "@/lib/pager/auth";
import { noContent, readJsonObject, storeFailure, unknownKeys } from "@/lib/pager/http";
import { limit } from "@/lib/pager/limits";
import { validateRules } from "@/lib/pager/rules";
import { StoreError, deleteWatch, getDesk, getState, getWatch, putWatch, sanitizeLabel, toWatchView, withDeskLock } from "@/lib/pager/store";
import type { Desk, Watch } from "@/lib/pager/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

type Ctx = { params: Promise<{ id: string }> };

const WATCH_ID_RE = /^w_[A-Za-z0-9_-]{6,20}$/;

class NotFound extends Error {}
class Invalid extends Error {}

/** Loads a watch only if it belongs to this desk (404 otherwise, never revealing other desks' watches). */
async function ownedWatch(desk: Desk, id: string): Promise<Watch | null> {
  if (!WATCH_ID_RE.test(id) || !desk.watchIds.includes(id)) return null;
  const w = await getWatch(id);
  return w && w.deskId === desk.id ? w : null;
}

/** GET /api/pager/watches/[id] */
export async function GET(req: Request, { params }: Ctx) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("watchList", desk.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    const w = await ownedWatch(desk, id);
    if (!w) return apiError("Watch not found on this desk", 404);
    return json({ watch: toWatchView(w, await getState(id)) });
  } catch (e) {
    return storeFailure(e, "getWatch");
  }
}

/** PATCH /api/pager/watches/[id] — `{ enabled?, label?, rules? }`. Rules merge over the current config. */
export async function PATCH(req: Request, { params }: Ctx) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("watchPatch", desk.id);
  if (limited) return limited;
  const { id } = await params;

  const body = await readJsonObject(req, { maxBytes: 16_384 });
  if (body instanceof Response) return body;
  const bad = unknownKeys(body, ["enabled", "label", "rules"]);
  if (bad) return bad;
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return apiError("enabled must be a boolean", 400);
  if (body.label !== undefined && typeof body.label !== "string") return apiError("label must be a string", 400);
  if (body.rules !== undefined && !Array.isArray(body.rules)) return apiError("rules must be an array", 400);

  try {
    // Under the desk lock so a concurrent DELETE can never be undone by this write.
    const updated = await withDeskLock(desk.id, async () => {
      const fresh = await requireFreshDesk(desk.id);
      const w = await ownedWatch(fresh, id);
      if (!w) throw new NotFound();
      const next: Watch = { ...w, updatedAt: Date.now() };
      if (typeof body.enabled === "boolean") next.enabled = body.enabled;
      if (typeof body.label === "string") {
        const label = sanitizeLabel(body.label);
        if (!label) throw new Invalid("label must contain visible characters");
        next.label = label;
      }
      if (body.rules !== undefined) {
        const v = validateRules(body.rules, w.kind, w.meta, w.rules);
        if (!v.ok) throw new Invalid(v.error);
        next.rules = v.rules;
      }
      await putWatch(next);
      return next;
    });
    return json({ watch: toWatchView(updated, await getState(id)) });
  } catch (e) {
    if (e instanceof NotFound) return apiError("Watch not found on this desk", 404);
    if (e instanceof Invalid) return apiError(e.message, 400);
    if (e instanceof StoreError) return apiError(e.message, e.status);
    return storeFailure(e, "patchWatch");
  }
}

/** DELETE /api/pager/watches/[id] */
export async function DELETE(req: Request, { params }: Ctx) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("watchDelete", desk.id);
  if (limited) return limited;
  const { id } = await params;
  if (!WATCH_ID_RE.test(id)) return apiError("Watch not found on this desk", 404);
  try {
    return (await deleteWatch(desk.id, id)) ? noContent() : apiError("Watch not found on this desk", 404);
  } catch (e) {
    return storeFailure(e, "deleteWatch");
  }
}

async function requireFreshDesk(id: string): Promise<Desk> {
  const d = await getDesk(id);
  if (!d) throw new NotFound();
  return d;
}
