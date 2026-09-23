import type { AgentState, RunState, StoredEvent, WsServerMessage } from "@agentspace/spec-types";

export const MAX_EVENTS = 500;

export interface OfficeState {
  agents: Record<string, AgentState>;
  runs: Record<string, RunState>;
  /** Oldest first, capped at MAX_EVENTS. */
  events: StoredEvent[];
  ready: boolean;
}

export const emptyState: OfficeState = { agents: {}, runs: {}, events: [], ready: false };

export function reduce(state: OfficeState, msg: WsServerMessage): OfficeState {
  switch (msg.type) {
    case "snapshot":
      return {
        agents: Object.fromEntries(msg.agents.map((a) => [a.agent_id, a])),
        runs: Object.fromEntries(msg.runs.map((r) => [r.run_id, r])),
        events: msg.events.slice(-MAX_EVENTS),
        ready: true,
      };
    case "events": {
      const lastSeq = state.events.at(-1)?.seq ?? 0;
      const fresh = msg.events.filter((e) => e.seq > lastSeq);
      if (!fresh.length) return state;
      const events = state.events.concat(fresh);
      return { ...state, events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events };
    }
    case "agents":
      return { ...state, agents: { ...state.agents, ...Object.fromEntries(msg.agents.map((a) => [a.agent_id, a])) } };
    case "runs":
      return { ...state, runs: { ...state.runs, ...Object.fromEntries(msg.runs.map((r) => [r.run_id, r])) } };
  }
}

export interface Team {
  id: string;
  agents: AgentState[];
}

/** Group agents by team for the office layout. Unassigned agents go last. */
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
