import { getRibbonTelemetry, type RibbonTelemetry } from "@/lib/engine/telemetry";

const TTL_MS = 15_000;
const g = globalThis as typeof globalThis & { __kestrelRibbon?: { at: number; value: RibbonTelemetry } | null; __kestrelRibbonInflight?: Promise<RibbonTelemetry> | null };

/**
 * Ribbon telemetry (block heights + $VIBES OFT 1:1 invariant) memoised in-process for 15s with in-flight coalescing.
 * Deliberately not KV-backed: the ribbon renders in the root layout, and a no-store KV fetch there would force every
 * static / ISR page dynamic. Clients refresh it from /api/telemetry (CDN-cached for 15s).
 */
export function getRibbonTelemetryCached(): Promise<RibbonTelemetry> {
  const hit = g.__kestrelRibbon;
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  if (g.__kestrelRibbonInflight) return g.__kestrelRibbonInflight;
  const p = getRibbonTelemetry()
    .then((value) => {
      // Only memoise fully successful reads so a transient RPC miss is retried on the next request.
      if (value.baseBlock && value.rhBlock && value.parity !== "UNKNOWN") g.__kestrelRibbon = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      g.__kestrelRibbonInflight = null;
    });
  g.__kestrelRibbonInflight = p;
  return p;
}
