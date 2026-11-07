import { apiError, json, preflight } from "@/lib/api";
import type { ChainId } from "@/lib/engine/types";
import { chainName } from "@/lib/format";
import { requireDesk } from "@/lib/pager/auth";
import { MAX_RANGE } from "@/lib/pager/constants";
import { activeChannels, deliver, type Delivery } from "@/lib/pager/deliver";
import { blankState, computeGlobals, evaluateWatch } from "@/lib/pager/evaluate";
import { readJsonObject, storeFailure, unknownKeys } from "@/lib/pager/http";
import { limit } from "@/lib/pager/limits";
import { watchActions } from "@/lib/pager/links";
import { type ChainSnapshot, planChains, planFor, prefetchChangedImpls, probeChain } from "@/lib/pager/probes";
import { renderAlerts, renderNotice } from "@/lib/pager/render";
import { getGlobal, getState, getWatch } from "@/lib/pager/store";
import type { Desk, Watch, WatchState } from "@/lib/pager/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = preflight;

type Ctx = { params: Promise<{ id: string }> };
const WATCH_ID_RE = /^w_[A-Za-z0-9_-]{6,20}$/;

async function ownedWatch(desk: Desk, id: string): Promise<Watch | null> {
  if (!WATCH_ID_RE.test(id) || !desk.watchIds.includes(id)) return null;
  const w = await getWatch(id);
  return w && w.deskId === desk.id ? w : null;
}

/**
 * POST /api/pager/watches/[id]/test — `{ dispatch?: boolean }`.
 * Dry run of every enabled rule of one watch against LIVE chain state (the same batched probe pass the
 * tick runs, log window = blocks since the watch's last check, capped like the tick). Never mutates the
 * watch state. Returns per-rule observations and the rendered message; with `dispatch: true` the message
 * is also sent to the desk's channels (labelled TEST).
 */
export async function POST(req: Request, { params }: Ctx) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("watchTest", desk.id);
  if (limited) return limited;
  const { id } = await params;

  const body = await readJsonObject(req, { maxBytes: 1_024, optional: true });
  if (body instanceof Response) return body;
  const bad = unknownKeys(body, ["dispatch"]);
  if (bad) return bad;
  if (body.dispatch !== undefined && typeof body.dispatch !== "boolean") return apiError("dispatch must be a boolean", 400);

  let watch: Watch | null;
  let state: WatchState | null;
  let parityPrev: Awaited<ReturnType<typeof getGlobal>>["parity"] | null = null;
  try {
    watch = await ownedWatch(desk, id);
    if (!watch) return apiError("Watch not found on this desk", 404);
    state = await getState(id);
    parityPrev = (await getGlobal().catch(() => null))?.parity ?? null;
  } catch (e) {
    return storeFailure(e, "watchTest");
  }

  const now = Date.now();
  const prev = state ?? blankState(watch, now);
  const evalWatch: Watch = { ...watch, enabled: true };
  const plan = planFor(evalWatch, prev);
  const chains = [...new Set<ChainId>([watch.chainId, ...planChains(plan)])];
  const snaps: Partial<Record<ChainId, ChainSnapshot>> = {};
  const probeErrors: string[] = [];
  await Promise.all(
    chains.map(async (c) => {
      try {
        // Log window: since the last check (what the next tick would see), capped like the tick.
        const last = prev.lastCheckedBlock && c === watch!.chainId ? BigInt(prev.lastCheckedBlock) : null;
        snaps[c] = await probeChain(c, plan, last, { maxRange: MAX_RANGE[c] });
        probeErrors.push(...snaps[c]!.errors.map((e) => `${chainName(c)}: ${e}`));
      } catch (e) {
        probeErrors.push(`${chainName(c)}: probe failed (${e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 120) : "error"})`);
      }
    })
  );
  const snap = snaps[watch.chainId];
  if (!snap) return apiError(`Live ${chainName(watch.chainId)} read failed; try again shortly`, 502, { errors: probeErrors });

  const newImplCode = await prefetchChangedImpls([evalWatch], { [watch.id]: prev }, snaps).catch(() => ({}));
  const globals = computeGlobals(snaps, parityPrev, now);
  const { alerts, observations } = evaluateWatch({ now, snap: snaps, globals, links: (w, extra) => watchActions(w, extra ?? {}), newImplCode }, evalWatch, prev);

  const rendered = alerts.length
    ? renderAlerts(desk, alerts.map((a) => ({ ...a, title: `[TEST] ${a.title}` })), { labels: { [watch.id]: watch.label } })
    : renderNotice({
        event: "test",
        severity: "info",
        headline: `TEST · ${watch.label}`,
        title: `Live dry run: no rule would fire right now`,
        lines: [
          `${chainName(watch.chainId)} block #${snap.block.number} · blocks #${snap.range.from}–#${snap.range.to} scanned for events`,
          ...observations.map((o) => `${o.type}: ${o.observed} (fires on ${o.threshold})`),
        ].slice(0, 14),
        links: watchActions(watch),
        deskId: desk.id,
        data: { watchId: watch.id },
      });

  let delivered: (Delivery | { channel: "none"; target: "none"; ok: false; status: null; error: string })[] = [];
  if (body.dispatch === true) {
    const act = activeChannels(desk);
    if (!act.telegram && !act.webhook) {
      // Honest result instead of a silent empty list: nothing was sent because no channel is linked/enabled.
      const disabled = [desk.channels.telegram?.disabledReason, desk.channels.webhook?.disabledReason].filter(Boolean).join("; ");
      delivered = [{ channel: "none", target: "none", ok: false, status: null, error: disabled ? `Channel disabled: ${disabled}` : "No delivery channel linked: link Telegram or add a webhook first" }];
    } else {
      try {
        delivered = await deliver(desk, rendered, { deliveryId: `${desk.id}:test:${now}` });
      } catch (e) {
        console.error(`[pager] test dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
        delivered = [{ channel: "webhook", target: "dispatch", ok: false, status: null, error: "Dispatch failed unexpectedly; see server log" }];
      }
    }
  }

  return json({
    evaluatedAt: now,
    chainId: watch.chainId,
    block: snap.block.number.toString(),
    range: { from: snap.range.from.toString(), to: snap.range.to.toString(), gapBlocks: snap.range.gapBlocks.toString() },
    observations,
    alerts,
    message: { text: rendered.plain, html: rendered.html },
    delivered,
    errors: probeErrors,
  });
}
