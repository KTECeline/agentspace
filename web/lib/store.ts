"use client";

import { create } from "zustand";
import type { WsServerMessage } from "@agentspace/spec-types";
import { emptyState, reduce, type OfficeState } from "./state";

export type Connection = "connecting" | "live" | "reconnecting" | "offline" | "recording";

interface OfficeStore extends OfficeState {
  connection: Connection;
  sourceError: string | null;
  selectedAgent: string | null;
  hoveredAgent: string | null;
  apply: (msgs: WsServerMessage[]) => void;
  reset: () => void;
  setConnection: (c: Connection) => void;
  setSourceError: (e: string | null) => void;
  select: (agentId: string | null) => void;
  hover: (agentId: string | null) => void;
}

export const useOffice = create<OfficeStore>()((set) => ({
  ...emptyState,
  connection: "connecting",
  sourceError: null,
  selectedAgent: null,
  hoveredAgent: null,
  apply: (msgs) =>
    set((s) => {
      let next: OfficeState = s;
      for (const m of msgs) next = reduce(next, m);
      return next === s ? s : next;
    }),
  reset: () => set({ ...emptyState, selectedAgent: null, hoveredAgent: null }),
  setConnection: (connection) => set({ connection }),
  setSourceError: (sourceError) => set({ sourceError }),
  select: (selectedAgent) => set({ selectedAgent }),
  hover: (hoveredAgent) => set({ hoveredAgent }),
}));

// ---------------------------------------------------------------------------
// Frame batching: sources enqueue messages; they are applied at most once per animation
// frame, so 100 events/s never means 100 React renders/s. Hidden tabs don't run rAF, so fall
// back to a timer there (otherwise the queue would grow without bound).
// ---------------------------------------------------------------------------

const queue: WsServerMessage[] = [];
let scheduled = false;

function flush() {
  scheduled = false;
  if (!queue.length) return;
  useOffice.getState().apply(queue.splice(0));
}

export function enqueue(msg: WsServerMessage): void {
  queue.push(msg);
  if (scheduled) return;
  scheduled = true;
  const hidden = typeof document !== "undefined" && document.hidden;
  if (typeof requestAnimationFrame === "function" && !hidden) requestAnimationFrame(flush);
  else setTimeout(flush, 100);
}

/** Drop anything queued (used when switching sources). */
export function clearQueue(): void {
  queue.length = 0;
}
