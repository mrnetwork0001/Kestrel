"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";

/**
 * Flashes a faint phosphor wash (600ms, opacity-only overlay) when a polled value really changes.
 *   <LiveValue value={block}>#{block.toLocaleString()}</LiveValue>
 *   <LiveValue value={fmtCompact(x, 18)} />                 renders the value itself when no children
 * `value` is the comparison key (compared as a string against the previous render); never flashes on mount.
 * A countdown's own seconds rollover should not be wrapped in this.
 */
export function LiveValue({ value, children, className }: { value: string | number | bigint | null | undefined; children?: ReactNode; className?: string }) {
  const key = value == null ? "" : String(value);
  const prev = useRef(key);
  const [flash, setFlash] = useState<"a" | "b" | null>(null);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    setFlash((f) => (f === "a" ? "b" : "a"));
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [key]);
  return (
    <span className={cx("live-value", className)} data-flash={flash ?? undefined}>
      {children ?? key}
    </span>
  );
}
