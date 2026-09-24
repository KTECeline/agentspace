"use client";

import { create } from "zustand";
import type { ServerInfo, WsServerMessage } from "@agentspace/spec-types";
import { loadToken, saveToken } from "./collector";
import type { ReplayPlayer } from "./sources/replay";
import { emptyState, reduce, type OfficeState } from "./state";

export type Connection = "connecting" | "live" | "reconnecting" | "offline" | "recording" | "replay" | "unauthorized";

/** The live collector this page talks to (null for recordings and the stress test). */
export interface CollectorTarget {
  url: string;
  workspace: string;
}

interface OfficeStore extends OfficeState {
  connection: Connection;
  sourceError: string | null;
  selectedAgent: string | null;
  hoveredAgent: string | null;
  collector: CollectorTarget | null;
  /** GET /v1/info, once loaded. */
  info: ServerInfo | null;
  /** Operator token (kept in localStorage). */
  token: string | null;
  tokenDialogOpen: boolean;
  /** The player behind a recording or replay (drives the scrubber); null otherwise. */
  player: ReplayPlayer | null;
  apply: (msgs: WsServerMessage[]) => void;
  reset: () => void;
  setConnection: (c: Connection) => void;
  setSourceError: (e: string | null) => void;
  select: (agentId: string | null) => void;
  hover: (agentId: string | null) => void;
  setCollector: (c: CollectorTarget | null, info?: ServerInfo | null) => void;
  setToken: (token: string | null) => void;
  openTokenDialog: (open: boolean) => void;
  setPlayer: (player: ReplayPlayer | null) => void;
}

export const useOffice = create<OfficeStore>()((set) => ({
  ...emptyState,
  connection: "connecting",
  sourceError: null,
  selectedAgent: null,
  hoveredAgent: null,
  collector: null,
  info: null,
  token: null,
  tokenDialogOpen: false,
  player: null,
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
  setCollector: (collector, info = null) => set({ collector, info, token: collector ? loadToken() : null }),
  setToken: (token) => {
    saveToken(token);
    set({ token });
  },
  openTokenDialog: (tokenDialogOpen) => set({ tokenDialogOpen }),
  setPlayer: (player) => set({ player }),
}));

/** Operator actions are possible: a live collector that isn't in public read-only mode. */
export function useCanOperate(): boolean {
  return useOffice((s) => !!s.collector && !!s.info && s.info.operator_enabled);
}

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
