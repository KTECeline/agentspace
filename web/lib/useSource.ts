"use client";

import { useEffect, useMemo } from "react";
import { ApiError, fetchInfo, fetchRunEvents, loadToken } from "./collector";
import { buildTimeline } from "./replay";
import { liveSource } from "./sources/live";
import type { Recording } from "./sources/recorded";
import { ReplayPlayer } from "./sources/replay";
import { stressSource } from "./sources/stress";
import { clearQueue, enqueue, useOffice } from "./store";

export type SourceConfig =
  | { kind: "live"; collectorUrl: string; workspace: string }
  | { kind: "recording"; url: string; speed?: number }
  /** Replay one stored run from a collector, with a scrubber. */
  | { kind: "replay"; collectorUrl: string; workspace: string; runId: string }
  | { kind: "stress"; agents: number; rate: number };

/** Connects the chosen data source to the office store. Returns `retry` for live mode. */
export function useSource(config: SourceConfig): { retry: () => void; error: string | null } {
  const key = JSON.stringify(config);
  const live = useMemo(
    () => (config.kind === "live" ? liveSource(config.collectorUrl, config.workspace, () => useOffice.getState().token) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const error = useOffice((s) => s.sourceError);

  useEffect(() => {
    const { reset, setConnection, setSourceError, setCollector } = useOffice.getState();
    clearQueue();
    reset();
    setSourceError(null);
    setCollector(config.kind === "live" ? { url: config.collectorUrl, workspace: config.workspace } : null);
    const sink = { send: enqueue, setConnection };
    let stop = () => {};
    let cancelled = false;

    if (config.kind === "live" && live) stop = live.source(sink);
    else if (config.kind === "stress") stop = stressSource(config.agents, config.rate)(sink);
    else if (config.kind === "recording" || config.kind === "replay") {
      setConnection("connecting");
      const load =
        config.kind === "recording"
          ? fetch(config.url).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.json() as Promise<Recording>;
            })
          : fetchRunEvents(config.collectorUrl, config.workspace, config.runId, loadToken()).then(({ events, truncated }) => {
              if (!events.length) throw new Error("this run has no stored events (it may have been pruned by retention)");
              return { events, truncated };
            });
      load
        .then((rec) => {
          if (cancelled) return;
          // A recording plays as if it were happening now; a stored run keeps its real times.
          const events = config.kind === "recording" ? restamp(rec.events) : rec.events;
          const player =
            config.kind === "recording"
              ? new ReplayPlayer(buildTimeline(events), "demo", { speed: config.speed ?? 1, loop: true, connection: "recording" })
              : new ReplayPlayer(buildTimeline(events), config.workspace, {
                  connection: "replay",
                  note: "truncated" in rec && rec.truncated ? `Only the first ${events.length.toLocaleString()} events of this run are shown.` : undefined,
                });
          useOffice.getState().setPlayer(player);
          stop = player.source(sink);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setConnection("offline");
          const what = config.kind === "recording" ? "the recording" : "this run";
          const why =
            e instanceof ApiError && e.status === 401
              ? "the collector needs a token; add it in the office first"
              : e instanceof ApiError && e.status === 0
                ? "the collector isn't reachable"
                : e instanceof Error
                  ? e.message
                  : String(e);
          setSourceError(`Couldn't load ${what} (${why}).`);
        });
    }
    return () => {
      cancelled = true;
      stop();
      useOffice.getState().setPlayer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);

  // What the collector allows (auth, operator actions, public mode). Asked once it answers;
  // until then no operator controls are shown.
  const connection = useOffice((s) => s.connection);
  const hasInfo = useOffice((s) => s.info !== null);
  const collectorUrl = config.kind === "live" ? config.collectorUrl : null;
  useEffect(() => {
    if (!collectorUrl || hasInfo || (connection !== "live" && connection !== "unauthorized")) return;
    let stale = false;
    fetchInfo(collectorUrl)
      .then((info) => {
        const s = useOffice.getState();
        if (!stale && s.collector?.url === collectorUrl) s.setCollector(s.collector, info);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [collectorUrl, connection, hasInfo]);

  return { retry: live?.retry ?? (() => {}), error };
}

/** Shift a recording's timestamps so it starts now (its agents then look active, not "2 days ago"). */
function restamp<T extends { ts: string }>(events: T[]): T[] {
  const first = events.reduce((min, e) => Math.min(min, Date.parse(e.ts)), Infinity);
  if (!Number.isFinite(first)) return events;
  const shift = Date.now() - first;
  return events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) + shift).toISOString() }));
}
