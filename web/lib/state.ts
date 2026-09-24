import type { AgentState, ApprovalState, RunState, StoredEvent, WsServerMessage } from "@agentspace/spec-types";

export const MAX_EVENTS = 500;
export const MAX_AGENT_EVENTS = 200;
export const MAX_HANDOFFS = 50;

export interface OfficeState {
  agents: Record<string, AgentState>;
  runs: Record<string, RunState>;
  /** Oldest first, capped at MAX_EVENTS. */
  events: StoredEvent[];
  /** Per-agent history for the agent panel (oldest first, capped). */
  agentEvents: Record<string, StoredEvent[]>;
  /** Order in which agents first appeared; the office layout depends only on this, so desks never move. */
  firstSeen: Record<string, number>;
  /** Recent handoffs, for the packet animation. */
  handoffs: StoredEvent[];
  /** Approvals by id (pending and recently resolved). */
  approvals: Record<string, ApprovalState>;
  ready: boolean;
}

export const emptyState: OfficeState = {
  agents: {},
  runs: {},
  events: [],
  agentEvents: {},
  firstSeen: {},
  handoffs: [],
  approvals: {},
  ready: false,
};

function cap<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(-max) : list;
}

function withFirstSeen(firstSeen: Record<string, number>, ids: string[]): Record<string, number> {
  let out = firstSeen;
  let next = Object.keys(firstSeen).length;
  for (const id of ids) {
    if (out[id] === undefined) {
      if (out === firstSeen) out = { ...firstSeen };
      out[id] = next++;
    }
  }
  return out;
}

function appendAgentEvents(agentEvents: Record<string, StoredEvent[]>, events: StoredEvent[]): Record<string, StoredEvent[]> {
  const out = { ...agentEvents };
  for (const e of events) {
    for (const id of relatedAgents(e)) out[id] = cap([...(out[id] ?? []), e], MAX_AGENT_EVENTS);
  }
  return out;
}

/** Agents an event belongs to (a handoff belongs to both ends). */
export function relatedAgents(e: StoredEvent): string[] {
  if (e.type === "handoff") return [...new Set([e.data.from_agent_id, e.data.to_agent_id])];
  return e.agent_id ? [e.agent_id] : [];
}

export function reduce(state: OfficeState, msg: WsServerMessage): OfficeState {
  switch (msg.type) {
    case "snapshot": {
      const events = cap(msg.events, MAX_EVENTS);
      return {
        agents: Object.fromEntries(msg.agents.map((a) => [a.agent_id, a])),
        runs: Object.fromEntries(msg.runs.map((r) => [r.run_id, r])),
        events,
        agentEvents: appendAgentEvents({}, events),
        firstSeen: withFirstSeen({}, msg.agents.map((a) => a.agent_id)),
        handoffs: [],
        approvals: Object.fromEntries((msg.approvals ?? []).map((a) => [a.approval_id, a])),
        ready: true,
      };
    }
    case "events": {
      const lastSeq = state.events.at(-1)?.seq ?? 0;
      const fresh = msg.events.filter((e) => e.seq > lastSeq);
      if (!fresh.length) return state;
      const handoffs = fresh.filter((e) => e.type === "handoff");
      return {
        ...state,
        events: cap(state.events.concat(fresh), MAX_EVENTS),
        agentEvents: appendAgentEvents(state.agentEvents, fresh),
        handoffs: handoffs.length ? cap(state.handoffs.concat(handoffs), MAX_HANDOFFS) : state.handoffs,
      };
    }
    case "agents":
      return {
        ...state,
        agents: { ...state.agents, ...Object.fromEntries(msg.agents.map((a) => [a.agent_id, a])) },
        firstSeen: withFirstSeen(state.firstSeen, msg.agents.map((a) => a.agent_id)),
      };
    case "runs":
      return { ...state, runs: { ...state.runs, ...Object.fromEntries(msg.runs.map((r) => [r.run_id, r])) } };
    case "approvals":
      return { ...state, approvals: { ...state.approvals, ...Object.fromEntries(msg.approvals.map((a) => [a.approval_id, a])) } };
  }
}

export interface Team {
  id: string;
  agents: AgentState[];
}

/** Group agents by team for the 2D grid. Unassigned agents go last. */
export function groupByTeam(agents: AgentState[]): Team[] {
  const teams = new Map<string, AgentState[]>();
  for (const a of agents) {
    const key = a.team_id ?? "";
    const list = teams.get(key);
    if (list) list.push(a);
    else teams.set(key, [a]);
  }
  return [...teams.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([id, list]) => ({ id, agents: list.sort((x, y) => x.name.localeCompare(y.name)) }));
}

export function latestRun(runs: Record<string, RunState>): RunState | undefined {
  let best: RunState | undefined;
  for (const r of Object.values(runs)) {
    if (!best || (r.started_at ?? "") > (best.started_at ?? "")) best = r;
  }
  return best;
}
