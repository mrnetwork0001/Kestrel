/**
 * Next.js instrumentation hook: runs once when a server instance boots.
 * Arms the in-process Night-Shift Pager scheduler under `next dev` / long-running `next start`.
 * Skipped on Vercel (process.env.VERCEL), when PAGER_INPROCESS=0, during `next build`, and in the edge runtime.
 */
export async function register() {
  // Positive NEXT_RUNTIME check (replaced at build time) so the edge compilation drops the node-only import entirely.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.VERCEL || process.env.PAGER_INPROCESS === "0") return;
    const { startInProcessScheduler } = await import("./lib/pager/scheduler");
    startInProcessScheduler();
  }
}
