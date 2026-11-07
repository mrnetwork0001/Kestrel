"use client";

import { useEffect, useState } from "react";

/** Live UTC clock; "Night shift" = 22:00–06:00 UTC. Renders nothing until mounted to avoid hydration drift. */
export function NightShiftClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <span className="text-ink-3">UTC --:--:--</span>;
  const hh = now.getUTCHours();
  const night = hh >= 22 || hh < 6;
  const time = now.toISOString().slice(11, 19);
  return (
    <span className="flex items-center gap-2">
      <span className="tnum text-ink-2">{time} UTC</span>
      <span className={night ? "text-phosphor" : "text-ink-3"}>{night ? "NIGHT SHIFT ACTIVE >_" : "DAY DESK · SENTINEL ARMED >_"}</span>
    </span>
  );
}
