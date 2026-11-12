"use client";

import * as React from "react";

/**
 * Measures the `[data-active="true"]` child of `ref` so one absolutely
 * positioned indicator can slide between options. Until it has measured
 * (server render, first paint) it returns null and callers style the active
 * item directly, so nothing is ever unselected-looking.
 */
export function useIndicator(ref: React.RefObject<HTMLElement | null>, key: unknown) {
  const [box, setBox] = React.useState<{ left: number; width: number } | null>(null);
  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>('[data-active="true"]');
      setBox(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref, key]);
  return box;
}
