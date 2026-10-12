import { useEffect, useState } from "react";

/**
 * The current time in milliseconds, refreshed every `everyMs` while it is asked for (pass null to stop the
 * clock). One state per caller, so a clock only ticks where one is on screen.
 */
export function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (everyMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
