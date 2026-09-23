"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { WsServerMessage } from "@agentspace/spec-types";
import { emptyState, reduce } from "./state";

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

/**
 * Subscribes to the collector's WebSocket for one workspace. Reconnects with backoff; every
 * reconnect gets a fresh snapshot, so missed events never leave the view stale.
 */
export function useWorkspaceStream(collectorUrl: string, workspace: string) {
  const [state, dispatch] = useReducer(reduce, emptyState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let closed = false;

    const wsUrl = collectorUrl.replace(/^http/, "ws").replace(/\/$/, "") + `/v1/ws?workspace=${encodeURIComponent(workspace)}`;

    const open = () => {
      if (closed) return;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        failures = 0;
        setConnection("live");
      };
      socket.onmessage = (msg) => {
        try {
          dispatch(JSON.parse(String(msg.data)) as WsServerMessage);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (closed) return;
        failures += 1;
        // After a few failed tries, show "offline" (with a retry button) but keep trying slowly.
        setConnection(failures >= 4 ? "offline" : "reconnecting");
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** Math.min(failures, 5)));
      };
    };

    retryRef.current = () => {
      clearTimeout(timer);
      failures = 0;
      setConnection("reconnecting");
      socket?.close();
      open();
    };

    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [collectorUrl, workspace]);

  return { state, connection, retry: () => retryRef.current() };
}

/** Re-render every `ms` (for "3s ago" labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
