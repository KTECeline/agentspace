"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Returns `value`, but updates at most once every `ms`. It always settles on the latest
 * value. Used for DOM-heavy views (the event log) that don't need 60 Hz updates.
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const wait = last.current + ms - Date.now();
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        last.current = Date.now();
        setShown(value);
      },
      Math.max(0, wait),
    );
    return () => clearTimeout(timer.current);
  }, [value, ms]);

  return shown;
}
