import { getAddress, isAddress } from "viem";
import { apiError, json, preflight } from "@/lib/api";
import type { ChainId } from "@/lib/engine/types";
import { ArmError, armWatch, type ArmResult } from "@/lib/pager/arm";
import { requireDesk } from "@/lib/pager/auth";
import { readJsonObject, storeFailure, unknownKeys } from "@/lib/pager/http";
import { limit, maxWatchesPerDesk, maxWatchesTotal } from "@/lib/pager/limits";
import {
  StoreError,
  addWatch,
  countWatchesTotal,
  getWatches,
  listWatchViews,
  newWatchId,
  sanitizeLabel,
  toWatchView,
} from "@/lib/pager/store";
import type { Hex, Watch, WatchState } from "@/lib/pager/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // arming reads live state synchronously (3–15 s)

export const OPTIONS = preflight;

const CHAINS: readonly ChainId[] = [8453, 4663];
const MAX_EXTRA_TOKENS = 10;
const MAX_RULE_ENTRIES = 32;

/** GET /api/pager/watches — the desk's watches with display-ready status. */
export async function GET(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("watchList", desk.id);
  if (limited) return limited;
  try {
    return json({ watches: await listWatchViews(desk), limits: { maxWatches: maxWatchesPerDesk() } });
  } catch (e) {
    return storeFailure(e, "listWatches");
  }
}

/**
 * POST /api/pager/watches — arm a watch. Arming is synchronous: it classifies the target and seeds baselines
 * from live mainnet reads, so the first tick compares against real state (never a placeholder).
 */
export async function POST(req: Request) {
  const desk = await requireDesk(req);
  if (desk instanceof Response) return desk;
  const limited = await limit("watchCreate", desk.id);
  if (limited) return limited;

  const body = await readJsonObject(req, { maxBytes: 16_384 });
  if (body instanceof Response) return body;
  const bad = unknownKeys(body, ["address", "chainId", "label", "rules", "extraTokens"]);
  if (bad) return bad;

  // ---- validate ----
  if (typeof body.address !== "string" || !isAddress(body.address.trim(), { strict: false })) {
    return apiError("address must be a 0x-prefixed 20-byte address", 400);
  }
  const address = getAddress(body.address.trim()) as Hex;
  const chainNum = typeof body.chainId === "string" && /^\d+$/.test(body.chainId) ? Number(body.chainId) : body.chainId ?? 8453;
  if (!CHAINS.includes(chainNum as ChainId)) return apiError("chainId must be 8453 (Base) or 4663 (Robinhood Chain)", 400);
  const chainId = chainNum as ChainId;

  let label: string | undefined;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== "string") return apiError("label must be a string", 400);
    label = sanitizeLabel(body.label) || undefined;
  }

  let rules: unknown[] | undefined;
  if (body.rules !== undefined && body.rules !== null) {
    if (!Array.isArray(body.rules)) return apiError("rules must be an array", 400);
    if (body.rules.length > MAX_RULE_ENTRIES) return apiError(`at most ${MAX_RULE_ENTRIES} rule entries`, 400);
    rules = body.rules;
  }

  let extraTokens: Hex[] | undefined;
  if (body.extraTokens !== undefined && body.extraTokens !== null) {
    if (!Array.isArray(body.extraTokens) || body.extraTokens.length > MAX_EXTRA_TOKENS) {
      return apiError(`extraTokens must be an array of at most ${MAX_EXTRA_TOKENS} token addresses`, 400);
    }
    const out = new Map<string, Hex>();
    for (const t of body.extraTokens) {
      if (typeof t !== "string" || !isAddress(t.trim(), { strict: false })) return apiError("extraTokens entries must be token addresses", 400);
      const a = getAddress(t.trim()) as Hex;
      out.set(a.toLowerCase(), a);
    }
    extraTokens = [...out.values()];
  }

  // ---- cheap pre-checks before the expensive live arm ----
  const max = maxWatchesPerDesk();
  if (desk.watchIds.length >= max && !desk.system) return apiError(`Desk is full (max ${max} watches). Delete one first.`, 429);
  try {
    const existing = await getWatches(desk.watchIds);
    if (existing.some((w) => w.chainId === chainId && w.target.toLowerCase() === address.toLowerCase())) {
      return apiError("This desk already watches that target on that chain", 409);
    }
    if ((await countWatchesTotal()) >= maxWatchesTotal()) return apiError("Night shift at capacity, try again later", 503);
  } catch (e) {
    return storeFailure(e, "watchPrecheck");
  }

  // ---- arm from live chain state ----
  let armed: ArmResult;
  try {
    armed = await armWatch(desk, { address, chainId, label, rules, extraTokens });
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 200) : "unknown error";
    if (e instanceof ArmError && e.status >= 400 && e.status < 500) return apiError(msg, e.status);
    console.error(`[pager] arm ${chainId}:${address} failed: ${msg}`);
    return apiError(`Could not arm the watch: live chain read failed (${msg})`, 502);
  }

  const now = Date.now();
  const watch: Watch = {
    ...armed.watch,
    v: 1,
    id: /^w_[A-Za-z0-9_-]{6,20}$/.test(armed.watch.id ?? "") ? armed.watch.id : newWatchId(),
    deskId: desk.id,
    chainId,
    label: sanitizeLabel(label ?? armed.watch.label) || `${armed.watch.kind} ${address.slice(0, 6)}…${address.slice(-4)}`,
    createdAt: armed.watch.createdAt || now,
    updatedAt: now,
  };
  const state: WatchState = { ...armed.state, watchId: watch.id };

  try {
    await addWatch(watch, state, { maxTotal: maxWatchesTotal() });
  } catch (e) {
    if (e instanceof StoreError) return apiError(e.message, e.status);
    return storeFailure(e, "addWatch");
  }
  return json(
    {
      watch: toWatchView(watch, state, now),
      scan: armed.scan,
      observations: armed.observations,
      // Honest partial-baseline notes (e.g. one chain's RPC timed out); the first tick fills the gaps.
      baselineErrors: armed.baselineErrors,
    },
    { status: 201 }
  );
}
