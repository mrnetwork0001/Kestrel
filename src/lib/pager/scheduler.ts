/**
 * In-process Night-Shift scheduler for `next dev` and long-running `next start` servers.
 *
 * Calls runTick every PAGER_INPROCESS_INTERVAL_SEC (default 60 s). Never runs on Vercel (process.env.VERCEL is set;
 * serverless instances freeze between requests, so QStash / cron-job.org / Vercel Cron drive /api/pager/tick there),
 * when PAGER_INPROCESS=0, or during `next build`. Registration is idempotent per process: the timer is pinned on
 * globalThis so HMR re-runs of instrumentation never stack timers, while the tick function itself is refreshed on
 * every registration so dev edits take effect without a restart. The cross-instance tick lock still applies, so an
 * external scheduler hitting the same KV at the same time is harmless.
 *
 * Restart safety: instrumentation `register()` arms it on every server boot; `ensureInProcessScheduler()` (called
 * from /api/pager/status and the tick route) re-arms it if a boot path ever skipped instrumentation, and a watchdog
 * frees the `running` flag if one tick hangs past 3 intervals + 2 min (the KV tick lock TTL is 90 s).
 */
import "server-only";

type TickFn = () => Promise<void>;

interface SchedulerState {
  timer: ReturnType<typeof setInterval>;
  run: TickFn;
  running: boolean;
  runStartedAt: number | null;
  startedAt: number;
  intervalMs: number;
  lastRunAt: number | null;
  lastError: string | null;
}

const g = globalThis as typeof globalThis & { __kestrelPagerScheduler?: SchedulerState };

export function inProcessSchedulerEnabled(): boolean {
  if (process.env.VERCEL) return false;
  if (process.env.PAGER_INPROCESS === "0") return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  return true;
}

/** Public snapshot for /api/pager/status. */
export function inProcessSchedulerInfo(): { active: boolean; intervalSec: number | null; lastRunAt: number | null; lastError: string | null } {
  const s = g.__kestrelPagerScheduler;
  return s ? { active: true, intervalSec: Math.round(s.intervalMs / 1000), lastRunAt: s.lastRunAt, lastError: s.lastError } : { active: false, intervalSec: null, lastRunAt: null, lastError: null };
}

export function startInProcessScheduler(): void {
  if (!inProcessSchedulerEnabled()) return;
  const sec = Number.parseInt(process.env.PAGER_INPROCESS_INTERVAL_SEC ?? "", 10);
  const intervalMs = (Number.isFinite(sec) && sec >= 15 && sec <= 3_600 ? sec : 60) * 1000;

  const run: TickFn = async () => {
    const { runTick } = await import("@/lib/pager/tick");
    const s = await runTick({ reason: "in-process" });
    if (s.alerts || s.deliveries.ok || s.deliveries.failed || s.digests) {
      console.log(`[pager] tick ${s.tickId}: ${s.alerts} alert(s), ${s.deliveries.ok} delivered, ${s.deliveries.failed} failed, ${s.digests} digest(s) in ${s.durationMs} ms`);
    }
  };

  const existing = g.__kestrelPagerScheduler;
  if (existing) {
    existing.run = run; // HMR: keep the timer, swap in the fresh code
    return;
  }

  const fire = async () => {
    const st = g.__kestrelPagerScheduler;
    if (!st) return;
    if (st.running) {
      // Watchdog: a hung tick must not stop the night shift for the rest of the process lifetime.
      if (st.runStartedAt == null || Date.now() - st.runStartedAt < st.intervalMs * 3 + 120_000) return;
      console.warn("[pager] in-process tick still running after the watchdog limit; starting a new one");
    }
    st.running = true;
    st.runStartedAt = Date.now();
    try {
      await st.run();
      st.lastError = null;
    } catch (e) {
      st.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      console.warn(`[pager] in-process tick failed: ${st.lastError}`);
    } finally {
      st.running = false;
      st.runStartedAt = null;
      st.lastRunAt = Date.now();
    }
  };

  const timer = setInterval(fire, intervalMs);
  timer.unref?.();
  g.__kestrelPagerScheduler = { timer, run, running: false, runStartedAt: null, startedAt: Date.now(), intervalMs, lastRunAt: null, lastError: null };
  // First pass shortly after boot (lets the server finish compiling routes first).
  const first = setTimeout(fire, 15_000);
  first.unref?.();
  console.log(`[pager] in-process Night-Shift scheduler armed (every ${intervalMs / 1000}s; disable with PAGER_INPROCESS=0)`);
}

/** Idempotent: arms the in-process scheduler if it is enabled here and not yet running (no-op otherwise). */
export function ensureInProcessScheduler(): void {
  if (!g.__kestrelPagerScheduler && inProcessSchedulerEnabled()) startInProcessScheduler();
}
