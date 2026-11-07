"use client";

import { useEffect, useRef, useState } from "react";

/** Client island for <Led mode="event">: re-mounts the ping ring each time eventKey changes (never on mount). */
export function LedPing({ eventKey }: { eventKey: string | null }) {
  const prev = useRef(eventKey);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (prev.current !== eventKey) {
      prev.current = eventKey;
      if (eventKey != null) setN((x) => x + 1);
    }
  }, [eventKey]);
  return n > 0 ? <span key={n} className="led-ping" /> : null;
}
