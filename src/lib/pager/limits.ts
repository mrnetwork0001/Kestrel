/**
 * Pager rate limits and capacity caps. Fixed-window counters on the shared KV (`kvIncrWithExpiry`:
 * INCRBY + EXPIRE NX in one round-trip), with a process-local fallback if KV is unreachable.
 * Keys: `rl:pager:{bucket}:{subject}:{window}` (subject = desk id or a daily-rotating IP hash; never a raw key).
 */
import "server-only";
import { apiError } from "@/lib/api";
import { kvIncrWithExpiry, localIncrWithExpiry } from "@/lib/kv";

export interface LimitRule { limit: number; windowSec: number }

/** Per-endpoint limits from spec section 13. */
export const LIMITS = {
  deskCreate: { limit: 5, windowSec: 3600 },      // per IP (IPv6: per /64)
  deskCreateGlobal: { limit: 120, windowSec: 3600 }, // all networks combined (anonymous desk creation)
  deskRead: { limit: 60, windowSec: 60 },         // per desk
  deskPatch: { limit: 30, windowSec: 60 },        // per desk
  deskDelete: { limit: 5, windowSec: 3600 },      // per desk
  watchList: { limit: 60, windowSec: 60 },        // per desk
  watchCreate: { limit: 20, windowSec: 3600 },    // per desk
  watchPatch: { limit: 60, windowSec: 60 },       // per desk
  watchDelete: { limit: 60, windowSec: 60 },      // per desk
  watchTest: { limit: 6, windowSec: 60 },         // per desk
  tgLinkCreate: { limit: 5, windowSec: 600 },     // per desk
  tgLinkPoll: { limit: 60, windowSec: 60 },       // per desk
  tgLinkDelete: { limit: 10, windowSec: 60 },     // per desk
  sleep: { limit: 10, windowSec: 3600 },          // per desk
  status: { limit: 60, windowSec: 60 },           // per IP
} as const satisfies Record<string, LimitRule>;

export type LimitBucket = keyof typeof LIMITS;

const envInt = (name: string, dflt: number, min = 1, max = 100_000): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

/** Max watches per desk (`PAGER_MAX_WATCHES_PER_DESK`, default 10). */
export const maxWatchesPerDesk = (): number => envInt("PAGER_MAX_WATCHES_PER_DESK", 10, 1, 1_000);
/** Global watch cap across all desks (`PAGER_MAX_WATCHES_TOTAL`, default 500). */
export const maxWatchesTotal = (): number => envInt("PAGER_MAX_WATCHES_TOTAL", 500, 1, 100_000);
/**
 * Share of the global watch cap available to desks with NO verified delivery channel (`PAGER_MAX_CHANNELLESS_WATCHES`,
 * default 60% of PAGER_MAX_WATCHES_TOTAL). Anonymous channel-less desks can never exhaust the capacity reserved for
 * desks that actually receive pages.
 */
export const maxChannellessWatches = (): number => envInt("PAGER_MAX_CHANNELLESS_WATCHES", Math.floor(maxWatchesTotal() * 0.6), 0, 100_000);

/** Global cap that applies to a new watch on `desk` (null = a desk about to be created, i.e. channel-less). */
export function watchCapFor(
  desk: { system?: boolean; channels: { telegram: { verified: boolean; disabledReason: string | null } | null; webhook: { disabledReason: string | null } | null } } | null
): number {
  const total = maxWatchesTotal();
  if (!desk) return Math.min(total, maxChannellessWatches());
  const tg = desk.channels.telegram;
  const hasChannel = !!desk.system || (!!tg && tg.verified && !tg.disabledReason) || (!!desk.channels.webhook && !desk.channels.webhook.disabledReason);
  return hasChannel ? total : Math.min(total, maxChannellessWatches());
}

/** Global desk cap (`PAGER_MAX_DESKS_TOTAL`, default 5000); abandoned empty desks are pruned before refusing. */
export const maxDesksTotal = (): number => envInt("PAGER_MAX_DESKS_TOTAL", 5_000, 10, 1_000_000);

/** Max desks one IP (daily hash) can open per day (`PAGER_MAX_DESKS_PER_IP_DAY`, default 20). */
export const maxDesksPerIpDay = (): number => envInt("PAGER_MAX_DESKS_PER_IP_DAY", 20, 1, 10_000);
/** Expected scheduler cadence in seconds (`PAGER_CADENCE_SEC`, default 240 = every 4 min: 360 QStash messages/day, under the free 500/day). */
export const cadenceSec = (): number => envInt("PAGER_CADENCE_SEC", 240, 10, 86_400);

/** Increments the window counter; returns `{ limited, retryAfterSec }`. Never throws. */
export async function hit(bucket: string, subject: string, rule: LimitRule, cost = 1): Promise<{ limited: boolean; count: number; retryAfterSec: number }> {
  const now = Date.now();
  const win = Math.floor(now / (rule.windowSec * 1000));
  const key = `rl:pager:${bucket}:${subject}:${win}`;
  let count: number;
  try {
    count = await kvIncrWithExpiry(key, rule.windowSec, cost);
  } catch (e) {
    console.warn(`[pager] rate-limit KV unavailable, using local counter: ${e instanceof Error ? e.message : String(e)}`);
    count = localIncrWithExpiry(key, rule.windowSec, cost);
  }
  const retryAfterSec = Math.max(1, Math.ceil(((win + 1) * rule.windowSec * 1000 - now) / 1000));
  return { limited: count > rule.limit, count, retryAfterSec };
}

/** Applies a named limit; returns a 429 Response (with Retry-After) when exceeded, else null. */
export async function limit(bucket: LimitBucket, subject: string): Promise<Response | null> {
  const rule = LIMITS[bucket];
  const r = await hit(bucket, subject, rule);
  if (!r.limited) return null;
  const res = apiError(`Rate limit: max ${rule.limit} per ${fmtWindow(rule.windowSec)}`, 429, { retryAfterSec: r.retryAfterSec });
  res.headers.set("Retry-After", String(r.retryAfterSec));
  return res;
}

function fmtWindow(sec: number): string {
  if (sec % 3600 === 0) return sec === 3600 ? "hour" : `${sec / 3600} hours`;
  if (sec % 60 === 0) return sec === 60 ? "minute" : `${sec / 60} minutes`;
  return `${sec} s`;
}
