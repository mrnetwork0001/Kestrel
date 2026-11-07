import { getRibbonTelemetryCached } from "@/lib/ribbon";
import { TelemetryRibbonLive } from "./telemetry-ribbon-live";

/**
 * Persistent top ribbon: server-read live values (memoised 15s), refreshed client-side from /api/telemetry.
 * `.ribbon-compact` (globals.css) keeps it to one horizontally scrollable 29px line at <=900px instead of wrapping.
 */
export async function TelemetryRibbon() {
  const t = await getRibbonTelemetryCached();
  return (
    <div className="ribbon-compact">
      <TelemetryRibbonLive initial={t} />
    </div>
  );
}
