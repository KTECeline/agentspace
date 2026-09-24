import type { AgentSpaceEvent, AgentState, ApprovalState, ApprovalStatus, StoredEvent, WsServerMessage } from "@agentspace/spec-types";
import { Projector } from "./projector";
import { MAX_EVENTS } from "./state";

/**
 * Replay model (pure, tested in tests/replay.test.ts): a run's stored events laid out on a
 * timeline, the moments worth jumping to, and the office state at any point in it.
 */

export type MarkerKind = "error" | "handoff" | "control" | "approval";

export interface Marker {
  /** Index of the event in the timeline. */
  index: number;
  /** Replay time of the event, ms from the start. */
  at: number;
  kind: MarkerKind;
  label: string;
}

export interface Timeline {
  events: AgentSpaceEvent[];
  /** Replay time of each event, ms from the start (idle gaps squashed). */
  times: number[];
  duration: number;
  markers: Marker[];
  /** Agent ids in the order they first appear, so desks never move while scrubbing. */
  agentOrder: string[];
}

/** Longest pause kept between two events; longer waits (a human approving, say) are squashed. */
export const MAX_GAP_MS = 3000;

export function buildTimeline(input: AgentSpaceEvent[], maxGapMs = MAX_GAP_MS): Timeline {
  // Stable sort by timestamp: collectors return events in arrival order, which can differ.
  const events = input
    .map((e, i) => ({ e, i, t: Date.parse(e.ts) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);
  const times: number[] = [];
  const markers: Marker[] = [];
  const agentOrder: string[] = [];
  const seen = new Set<string>();
  let at = 0;
  let prev = events[0] ? Date.parse(events[0].ts) : 0;
  events.forEach((e, index) => {
    const t = Date.parse(e.ts);
    at += Math.min(Math.max(0, t - prev), maxGapMs);
    prev = t;
    times.push(at);
    for (const id of e.type === "handoff" ? [e.data.from_agent_id, e.data.to_agent_id] : e.agent_id ? [e.agent_id] : []) {
      if (!seen.has(id)) {
        seen.add(id);
        agentOrder.push(id);
      }
    }
    const marker = markerFor(e);
    if (marker) markers.push({ index, at, ...marker });
  });
  return { events, times, duration: at, markers, agentOrder };
}

function markerFor(e: AgentSpaceEvent): Pick<Marker, "kind" | "label"> | null {
  switch (e.type) {
    case "error":
      return { kind: "error", label: `Error: ${e.data.message}` };
    case "run.finished":
      return e.data.status === "error" ? { kind: "error", label: "Run failed" } : null;
    case "handoff":
      return { kind: "handoff", label: `Handoff ${e.data.from_agent_id} → ${e.data.to_agent_id}` };
    case "run.control":
      return { kind: "control", label: `Run ${e.data.action === "pause" ? "paused" : e.data.action === "resume" ? "resumed" : "cancelled"}${e.data.by ? ` by ${e.data.by}` : ""}` };
    case "approval.requested":
      return { kind: "approval", label: `Approval asked: ${e.data.reason}` };
    case "approval.resolved":
      return { kind: "approval", label: `Approval ${e.data.decision}${e.data.resolved_by ? ` by ${e.data.resolved_by}` : ""}` };
    default:
      return null;
  }
}

/** Number of events that have happened at replay time `ms` (binary search). */
export function countAt(tl: Timeline, ms: number): number {
  let lo = 0;
  let hi = tl.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.times[mid]! <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The next (or previous) marker of a kind, strictly after (before) replay time `ms`. */
export function findMarker(tl: Timeline, ms: number, kind: MarkerKind | null, direction: 1 | -1): Marker | undefined {
  const matches = tl.markers.filter((m) => kind === null || m.kind === kind);
  // A small window so "previous" from just after a marker skips to the one before it.
  return direction === 1 ? matches.find((m) => m.at > ms) : matches.findLast((m) => m.at < ms - 250);
}

/** Approval rows from their events (the collector keeps a table; a replay rebuilds it). */
export function approvalsFrom(events: AgentSpaceEvent[]): ApprovalState[] {
  const out = new Map<string, ApprovalState>();
  for (const e of events) {
    if (e.type === "approval.requested") {
      out.set(e.data.approval_id, {
        workspace: e.workspace,
        approval_id: e.data.approval_id,
        run_id: e.run_id,
        agent_id: e.agent_id,
        team_id: e.team_id,
        reason: e.data.reason,
        payload: e.data.payload ?? null,
        status: "pending",
        comment: null,
        resolved_by: null,
        created_at: e.ts,
        expires_at: e.data.timeout_s !== undefined ? new Date(Date.parse(e.ts) + e.data.timeout_s * 1000).toISOString() : null,
        resolved_at: null,
      });
    } else if (e.type === "approval.resolved") {
      const a = out.get(e.data.approval_id);
      if (a) {
        out.set(a.approval_id, {
          ...a,
          status: e.data.decision as ApprovalStatus,
          comment: e.data.comment ?? null,
          resolved_by: e.data.resolved_by ?? null,
          resolved_at: e.ts,
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * The office as it was after the first `count` events: one snapshot message, projected with
 * the same rules as the collector. Agents come in first-appearance order (desks stay put).
 */
export function snapshotAt(tl: Timeline, count: number, workspace: string): { message: WsServerMessage; projector: Projector } {
  const projector = new Projector();
  const events: StoredEvent[] = [];
  const upto = tl.events.slice(0, count).map((e) => ({ ...e, workspace }) as AgentSpaceEvent);
  upto.forEach((e, i) => {
    projector.apply(e);
    if (i >= count - MAX_EVENTS) events.push({ ...e, seq: i + 1 });
  });
  const byId = new Map(projector.agentList(workspace).map((a) => [a.agent_id, a]));
  const agents = tl.agentOrder.map((id) => byId.get(id)).filter((a): a is AgentState => a !== undefined);
  return {
    message: { type: "snapshot", workspace, agents, runs: projector.runList(workspace), events, approvals: approvalsFrom(upto) },
    projector,
  };
}
