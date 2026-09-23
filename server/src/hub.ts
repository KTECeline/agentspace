import type { WebSocket } from "ws";
import type { WsServerMessage } from "@agentspace/spec-types";

/** Fans messages out to every browser subscribed to a workspace. */
export class Hub {
  private subs = new Map<string, Set<WebSocket>>();

  add(workspace: string, socket: WebSocket): void {
    let set = this.subs.get(workspace);
    if (!set) this.subs.set(workspace, (set = new Set()));
    set.add(socket);
    socket.on("close", () => {
      set.delete(socket);
      if (set.size === 0) this.subs.delete(workspace);
    });
  }

  broadcast(workspace: string, msg: WsServerMessage): void {
    const set = this.subs.get(workspace);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const socket of set) {
      // Skip slow clients rather than buffering without bound.
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < 8 * 1024 * 1024) {
        socket.send(data);
      }
    }
  }

  count(workspace?: string): number {
    if (workspace) return this.subs.get(workspace)?.size ?? 0;
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }
}
