import type { WsServerMessage } from "@agentspace/spec-types";
import type { Source } from "./types";

/**
 * The collector's WebSocket. Reconnects with backoff; each reconnect gets a fresh snapshot, so
 * missed events never leave the view stale. Returns a source plus a `retry` to skip the wait.
 */
export function liveSource(collectorUrl: string, workspace: string, getToken: () => string | null = () => null): { source: Source; retry: () => void } {
  let retryNow = () => {};
  const source: Source = (sink) => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let closed = false;
    let live = false;
    const wsUrl = collectorUrl.replace(/^http/, "ws").replace(/\/$/, "") + `/v1/ws?workspace=${encodeURIComponent(workspace)}`;

    const open = () => {
      if (closed) return;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        // Browsers can't set headers on a WebSocket, so the token goes in the first message.
        const token = getToken();
        if (token) socket?.send(JSON.stringify({ type: "auth", token }));
      };
      socket.onmessage = (msg) => {
        // "Live" only once the collector talks: a protected collector accepts the socket but
        // sends nothing until the token checks out.
        if (!live) {
          failures = 0;
          live = true;
          sink.setConnection("live");
        }
        try {
          sink.send(JSON.parse(String(msg.data)) as WsServerMessage);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = (ev) => {
        live = false;
        if (closed) return;
        if (ev.code === 4401) {
          // Needs a (valid) token: retrying won't help until one is entered, which calls retry().
          sink.setConnection("unauthorized");
          return;
        }
        failures += 1;
        // After a few failed tries show "offline" (with a retry button) but keep trying slowly.
        sink.setConnection(failures >= 4 ? "offline" : "reconnecting");
        timer = setTimeout(open, Math.min(10_000, 500 * 2 ** Math.min(failures, 5)));
      };
    };

    const drop = () => {
      if (!socket) return;
      // Detach first, so closing this socket doesn't schedule a reconnect of its own.
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
      socket = null;
      live = false;
    };

    retryNow = () => {
      clearTimeout(timer);
      failures = 0;
      sink.setConnection("reconnecting");
      drop();
      open();
    };

    sink.setConnection("connecting");
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      drop();
    };
  };
  return { source, retry: () => retryNow() };
}
