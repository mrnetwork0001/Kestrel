"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Renders the live telemetry ribbon everywhere except the paths listed (the landing page has its own live proof strip). */
export function RibbonGate({ children, hideOn = ["/"] }: { children: ReactNode; hideOn?: string[] }) {
  const pathname = usePathname();
  if (hideOn.includes(pathname)) return null;
  return <>{children}</>;
}
