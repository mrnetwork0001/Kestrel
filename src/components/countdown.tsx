"use client";

import { useEffect, useState } from "react";
import { fmtDuration } from "@/lib/format";

/** Live countdown to a unix timestamp (seconds). SSR renders the server-computed remainder. */
export function Countdown({ to, initialNow, className }: { to: number; initialNow: number; className?: string }) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const left = to - now;
  return <span className={className}>{left > 0 ? fmtDuration(left) : "window closed"}</span>;
}
