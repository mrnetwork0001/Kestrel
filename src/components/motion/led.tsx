import { cx } from "@/components/ui";
import { LedPing } from "./led-ping";

export type LedTone = "phosphor" | "base" | "rh" | "warn" | "crit" | "idle";

/**
 * Status LED: a 6px square (1px radius) with a 2px ring at 15% of its colour. Not an orb.
 *   <Led tone="phosphor" />                                   steady, server markup, no animation
 *   <Led tone="base" mode="event" eventKey={block} />         ring pings once each time eventKey changes
 * mode="event" never fires on mount and never on a timer. aria-hidden unless `label` is set (then role="img").
 */
export function Led({
  tone,
  mode = "steady",
  eventKey,
  label,
  className,
}: {
  tone: LedTone;
  mode?: "steady" | "event";
  eventKey?: string | number | bigint | null;
  label?: string;
  className?: string;
}) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <span className={cx("led", `led-${tone}`, className)} {...a11y}>
      {mode === "event" && <LedPing eventKey={eventKey == null ? null : String(eventKey)} />}
    </span>
  );
}
