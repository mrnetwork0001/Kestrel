import { cache } from "react";
import { CONTRACTS } from "@/config/contracts";
import { readEscrow } from "@/lib/engine/escrow";
import { guardVerdict } from "@/lib/engine/guard";
import { getBridgeParity } from "@/lib/engine/parity";
import { getPulseSnapshot } from "@/lib/engine/pulse";
import { scanTarget } from "@/lib/engine/scan";
import type { ParityReport } from "@/lib/engine/types";

/*
 * Request-scoped live reads for '/' (React cache): every Suspense section awaits the same promise, so the page makes one
 * scan, one parity read and one escrow read. The page is ISR (revalidate 60), so visitors get a static copy and the
 * sections only stream on a regeneration or in dev. The $VIBES token scan already carries the OFT parity report.
 */
export const getScan = cache(() => scanTarget(8453, CONTRACTS.base.vibesToken, { useLlm: false }).catch(() => null));
export const getParity = cache(async () => (await getScan())?.parity ?? (await getBridgeParity({ overnight: false }).catch(() => null)));
export const getEscrow = cache(() => readEscrow(8453, CONTRACTS.base.vibesGenesisEscrow).catch(() => null));
/** Sentinel Watch snapshot: the long block window + Permit2 / $VIBES events + last contact (in-process memo). */
export const getPulseSnap = cache(() => getPulseSnapshot().catch(() => null));
/** The real /api/v1/guard preview verdict for $VIBES (runs after the scan, so it reuses the scan's 30s cache). */
export const getGuard = cache(async () => ((await getScan()) ? guardVerdict(8453, CONTRACTS.base.vibesToken, "preview").catch(() => null) : null));

/** Parity verdict label (not `verified`): a LayerZero packet in flight is expected, not drift. Only UNBACKED is critical. */
export function parityVerdict(p: ParityReport): { label: string; tone: "phosphor" | "crit" | undefined; sub: string } {
  const v = p.verdict ?? (p.verified ? "EXACT" : "IN_FLIGHT");
  if (v === "EXACT") return { label: "EXACT", tone: "phosphor", sub: "locked = circulating" };
  if (v === "IN_FLIGHT") return { label: "IN FLIGHT", tone: undefined, sub: `${p.pendingPackets ?? "some"} packet${p.pendingPackets === 1 ? "" : "s"} in flight` };
  if (v === "OVER_BACKED") return { label: "OVER BACKED", tone: undefined, sub: "locked > circulating" };
  return { label: "UNBACKED", tone: "crit", sub: "circulating > locked" };
}
