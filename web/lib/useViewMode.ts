"use client";

import { useEffect, useState } from "react";

export type ViewMode = "3d" | "2d";
const KEY = "agentspace.view";

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** 3D by default; remembers the viewer's choice; falls back to 2D when WebGL is unavailable. */
export function useViewMode(): { mode: ViewMode; setMode: (m: ViewMode) => void; webgl: boolean; ready: boolean } {
  const [mode, setModeState] = useState<ViewMode>("3d");
  const [webgl, setWebgl] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const ok = hasWebGL();
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      // storage blocked: fine, use the default
    }
    // One-time sync from browser-only APIs after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWebgl(ok);
    setModeState(!ok ? "2d" : saved === "2d" ? "2d" : "3d");
    setReady(true);
  }, []);

  const setMode = (m: ViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      // ignore
    }
  };
  return { mode: webgl ? mode : "2d", setMode, webgl, ready };
}
