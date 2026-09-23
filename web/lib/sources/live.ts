import type { WsServerMessage } from "@agentspace/spec-types";
import type { Source } from "./types";

/**
 * The collector's WebSocket. Reconnects with backoff; each reconnect gets a fresh snapshot, so
 * missed events never leave the view stale. Returns a source plus a `retry` to skip the wait.
 */
export function liveSource(collectorUrl: string, workspace: string): { source: Source; retry: () => void } {
  let retryNow = () => {};
  const source: Source = (sink) => {
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
        sink.setConnection("live");
      };
      socket.onmessage = (msg) => {
        try {
          sink.send(JSON.parse(String(msg.data)) as WsServerMessage);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (closed) return;
        failures += 1;
        // After a few failed tries show "offline" (with a retry button) but keep trying slowly.
        sink.setConnection(failures >= 4 ? "offline" : "reconnecting");
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** Math.min(failures, 5)));
      };
    };

    retryNow = () => {
      clearTimeout(timer);
      failures = 0;
      sink.setConnection("reconnecting");
      socket?.close();
      open();
    };

    sink.setConnection("connecting");
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  };
  return { source, retry: () => retryNow() };
}
