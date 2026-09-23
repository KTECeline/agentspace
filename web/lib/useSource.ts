"use client";

import { useEffect, useMemo } from "react";
import { liveSource } from "./sources/live";
import { recordedSource, type Recording } from "./sources/recorded";
import { stressSource } from "./sources/stress";
import { clearQueue, enqueue, useOffice } from "./store";

export type SourceConfig =
  | { kind: "live"; collectorUrl: string; workspace: string }
  | { kind: "recording"; url: string; speed?: number }
  | { kind: "stress"; agents: number; rate: number };

/** Connects the chosen data source to the office store. Returns `retry` for live mode. */
export function useSource(config: SourceConfig): { retry: () => void; error: string | null } {
  const key = JSON.stringify(config);
  const live = useMemo(
    () => (config.kind === "live" ? liveSource(config.collectorUrl, config.workspace) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const error = useOffice((s) => s.sourceError);

  useEffect(() => {
    const { reset, setConnection, setSourceError } = useOffice.getState();
    clearQueue();
    reset();
    setSourceError(null);
    const sink = { send: enqueue, setConnection };
    let stop = () => {};
    let cancelled = false;

    if (config.kind === "live" && live) stop = live.source(sink);
    else if (config.kind === "stress") stop = stressSource(config.agents, config.rate)(sink);
    else if (config.kind === "recording") {
      setConnection("connecting");
      fetch(config.url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<Recording>;
        })
        .then((rec) => {
          if (!cancelled) stop = recordedSource(rec, "demo", { speed: config.speed ?? 1 })(sink);
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setConnection("offline");
            setSourceError(`Couldn't load the recording (${e instanceof Error ? e.message : String(e)}).`);
          }
        });
    }
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);

  return { retry: live?.retry ?? (() => {}), error };
}
