import { after } from "next/server";
import { apiError, json, preflight } from "@/lib/api";
import { kvMissingInProd, kvMode, kvSet } from "@/lib/kv";
import { ipHash } from "@/lib/pager/auth";
import { inProcessSchedulerEnabled, inProcessSchedulerInfo } from "@/lib/pager/scheduler";
import { schedulerConfigured } from "@/lib/pager/schedule-auth";
import { cadenceSec, limit } from "@/lib/pager/limits";
import * as store from "@/lib/pager/store";
import { tgConfigured, tgMode } from "@/lib/pager/telegram";
import { runTick, verifyTickChain } from "@/lib/pager/tick";
import type { ChainId } from "@/lib/engine/types";
import type { TickSummary } from "@/lib/pager/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAINS: ChainId[] = [8453, 4663];

/** Opportunistic tick (safety net when no external scheduler is configured): at most one per minute across instances. */
async function maybeTriggerTick(lastAt: number | null, cadence: number): Promise<boolean> {
  if (kvMissingInProd()) return false;
  const stale = !lastAt || Date.now() - lastAt > cadence * 3 * 1000;
  if (!stale) return false;
  const go = await kvSet("pager:opportunistic", String(Date.now()), { ex: 60, nx: true }).catch(() => false);
  if (!go) return false;
  after(() => runTick({ reason: "opportunistic" }).then(() => undefined, (e) => console.warn("[pager] opportunistic tick failed:", e instanceof Error ? e.message : e)));
  return true;
}

function schedulerKind(last: TickSummary | null): string {
  const inproc = inProcessSchedulerInfo();
  if (inproc.active) return "in-process";
  if (last?.reason === "qstash") return "qstash";
  if (last?.reason === "cron-secret") return "cron";
  if (schedulerConfigured()) return "external (configured)";
  return "opportunistic-only";
}

const n = (s: string | undefined) => (s && /^\d+$/.test(s) ? BigInt(s) : null);

/**
 * GET /api/pager/status — public Night-Shift Log (proof-of-watch). Shows when the sentinel last checked each chain,
 * the scheduler, storage mode, and the newest hash-chained tick summaries (sha256(prevHash + summary)), verified here.
 * If the last tick is older than 3× the cadence, it triggers one opportunistic tick in the background.
 * `?log=N` returns up to 50 tick summaries (default 10).
 */
export async function GET(req: Request) {
  const limited = await limit("status", ipHash(req));
  if (limited) return limited;
  const url = new URL(req.url);
  const logN = Math.max(0, Math.min(50, Number.parseInt(url.searchParams.get("log") ?? "10", 10) || 0));
  const cadence = inProcessSchedulerInfo().intervalSec ?? cadenceSec();

  let last: TickSummary | null;
  let log: TickSummary[];
  let global: Awaited<ReturnType<typeof store.getGlobal>>;
  try {
    [last, log, global] = await Promise.all([store.getStatus(), store.ticklog(50), store.getGlobal()]);
  } catch (e) {
    console.error(`[pager] status read failed: ${e instanceof Error ? e.message : String(e)}`);
    return apiError("Pager storage unavailable", 503);
  }

  // Health is judged on the newest REAL tick (skipped "locked" never persists; no-storage never persists).
  const lastAt = last ? last.startedAt : null;
  const ageSec = lastAt ? Math.max(0, Math.round((Date.now() - lastAt) / 1000)) : null;
  const chainsOk = !!last && CHAINS.every((c) => last!.chains[c]?.ok);
  const healthy = !kvMissingInProd() && ageSec !== null && ageSec <= cadence * 3 && chainsOk;
  const triggered = await maybeTriggerTick(lastAt, cadence);

  const chainBlocks: Record<string, { block: string | null; ok: boolean; error?: string }> = {};
  for (const c of CHAINS) {
    const ch = last?.chains[c];
    chainBlocks[String(c)] = { block: ch?.ok ? ch.to : (global.cursor[c] ?? null), ok: !!ch?.ok, ...(ch?.error ? { error: ch.error } : {}) };
  }

  // Window covered by the stored log (up to 50 ticks), computed only from real summaries.
  const real = log.filter((t) => !t.skipped || t.skipped === "no-watches");
  const window = real.length
    ? {
        ticks: real.length,
        fromAt: real[real.length - 1].startedAt,
        toAt: real[0].startedAt,
        alerts: real.reduce((s, t) => s + t.alerts, 0),
        deliveries: real.reduce((s, t) => ({ ok: s.ok + t.deliveries.ok, failed: s.failed + t.deliveries.failed }), { ok: 0, failed: 0 }),
        digests: real.reduce((s, t) => s + t.digests, 0),
        blocks: Object.fromEntries(
          CHAINS.map((c) => {
            const tos = real.map((t) => (t.chains[c]?.ok ? n(t.chains[c]!.to) : null)).filter((x): x is bigint => x !== null);
            const froms = real.map((t) => (t.chains[c]?.ok ? n(t.chains[c]!.from) : null)).filter((x): x is bigint => x !== null);
            if (!tos.length || !froms.length) return [String(c), null];
            const hi = tos.reduce((a, b) => (b > a ? b : a));
            const lo = froms.reduce((a, b) => (b < a ? b : a));
            return [String(c), { from: lo.toString(), to: hi.toString(), count: (hi - lo + 1n).toString() }];
          })
        ),
      }
    : null;

  const chain = verifyTickChain(log);

  // Public $VIBES system desk (PAGER_SYSTEM_DESK_ID): labels, status and last alert only — never channels or keys.
  let systemDesk: { watches: { label: string; chainId: ChainId; kind: string; status: string; lastCheckedBlock: string | null; lastAlert: { title: string; severity: string; at: number } | null }[] } | undefined;
  const sysId = process.env.PAGER_SYSTEM_DESK_ID;
  if (sysId && /^[A-Za-z0-9_-]{10,40}$/.test(sysId)) {
    try {
      const sys = await store.getDesk(sysId);
      if (sys) {
        const views = await store.listWatchViews(sys);
        systemDesk = {
          watches: views.map((v) => ({
            label: v.label,
            chainId: v.chainId,
            kind: v.kind,
            status: v.status,
            lastCheckedBlock: v.state.lastCheckedBlock,
            lastAlert: v.state.lastAlert ? { title: v.state.lastAlert.title, severity: v.state.lastAlert.severity, at: v.state.lastAlert.at } : null,
          })),
        };
      }
    } catch {
      systemDesk = undefined;
    }
  }

  return json(
    {
      healthy,
      cadenceSec: cadence,
      scheduler: { kind: schedulerKind(last), inProcess: inProcessSchedulerEnabled() ? inProcessSchedulerInfo() : null, opportunisticTriggered: triggered },
      storage: kvMode(),
      telegram: { configured: tgConfigured(), mode: tgMode() },
      checks: global.tickCount,
      lastTick: last
        ? {
            tickId: last.tickId,
            at: last.startedAt,
            ageSec,
            reason: last.reason,
            durationMs: last.durationMs,
            chains: chainBlocks,
            watches: last.watches,
            evaluated: last.evaluated,
            alerts: last.alerts,
            deliveries: last.deliveries,
            hash: last.hash,
            prevHash: last.prevHash,
            ...(last.skipped ? { skipped: last.skipped } : {}),
          }
        : null,
      window,
      chain: { valid: chain.valid, checked: chain.checked, brokenAt: chain.brokenAt, algorithm: "sha256(prevHash + JSON(summary without hash))" },
      log: log.slice(0, logN),
      ...(systemDesk ? { systemDesk } : {}),
    },
    { cache: "public, s-maxage=15, stale-while-revalidate=30" }
  );
}

export const OPTIONS = preflight;
