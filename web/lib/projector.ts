import type { AgentSpaceEvent, AgentState, RunState } from "@agentspace/spec-types";

/**
 * Client-side mirror of the collector's SQL projections (server/src/store.ts), used when
 * playing recordings with no collector. Kept identical via the shared conformance fixture
 * spec/v0.1/examples/projection.expected.json (tested on both sides).
 */
export class Projector {
  readonly agents = new Map<string, AgentState>(); // key: workspace \0 agent_id
  readonly runs = new Map<string, RunState>(); // key: workspace \0 run_id
  private runOrder = new Map<string, number>();
  private clock = 0;

  /** Apply one event; returns the agent and run rows it changed. */
  apply(ev: AgentSpaceEvent): { agent?: AgentState; run: RunState } {
    this.clock += 1;
    const isLlm = ev.type === "llm.call";
    const tokensIn = isLlm ? (ev.tokens_in ?? 0) : 0;
    const tokensOut = isLlm ? (ev.tokens_out ?? 0) : 0;
    const cost = isLlm ? (ev.cost_usd ?? 0) : 0;

    // --- run ---
    const rkey = `${ev.workspace}\u0000${ev.run_id}`;
    let run = this.runs.get(rkey);
    if (!run) {
      run = {
        workspace: ev.workspace,
        run_id: ev.run_id,
        name: null,
        framework: null,
        status: "running",
        started_at: ev.ts,
        finished_at: null,
        duration_ms: null,
        event_count: 1,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: cost,
      };
    } else {
      run = {
        ...run,
        event_count: run.event_count + 1,
        tokens_in: run.tokens_in + tokensIn,
        tokens_out: run.tokens_out + tokensOut,
        cost_usd: run.cost_usd + cost,
      };
    }
    if (ev.type === "run.started") {
      run = { ...run, name: ev.data.name ?? run.name, framework: ev.data.framework ?? run.framework, started_at: ev.ts, status: "running" };
    } else if (ev.type === "run.finished") {
      run = { ...run, status: ev.data.status, finished_at: ev.ts, duration_ms: ev.data.duration_ms ?? null };
    }
    this.runs.set(rkey, run);
    this.runOrder.set(rkey, this.clock);

    if (!ev.agent_id) return { run };

    // --- agent ---
    const akey = `${ev.workspace}\u0000${ev.agent_id}`;
    let agent: AgentState = this.agents.get(akey) ?? {
      workspace: ev.workspace,
      agent_id: ev.agent_id,
      team_id: ev.team_id,
      name: ev.agent_id,
      role: null,
      framework: null,
      status: "idle",
      status_detail: null,
      last_summary: null,
      last_event_at: null,
      current_run_id: null,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      model: null,
    };
    if (ev.type === "agent.registered") {
      agent = { ...agent, team_id: ev.team_id, name: ev.data.name, role: ev.data.role ?? null, framework: ev.data.framework ?? null };
    } else if (ev.type === "agent.status") {
      agent = { ...agent, status: ev.data.status, status_detail: ev.data.detail ?? null };
    }
    agent = {
      ...agent,
      last_event_at: ev.ts,
      current_run_id: ev.run_id,
      team_id: ev.team_id ?? agent.team_id,
      last_summary: ev.summary ?? agent.last_summary,
      model: (isLlm ? ev.model : undefined) ?? agent.model,
      tokens_in: agent.tokens_in + tokensIn,
      tokens_out: agent.tokens_out + tokensOut,
      cost_usd: agent.cost_usd + cost,
    };
    this.agents.set(akey, agent);
    return { agent, run };
  }

  /** Same ordering as the collector's REST API. */
  agentList(workspace: string): AgentState[] {
    return [...this.agents.values()]
      .filter((a) => a.workspace === workspace)
      .sort((a, b) => cmp(a.team_id, b.team_id) || cmp(a.agent_id, b.agent_id));
  }

  runList(workspace: string): RunState[] {
    return [...this.runs.entries()]
      .filter(([, r]) => r.workspace === workspace)
      .sort(([a], [b]) => (this.runOrder.get(b) ?? 0) - (this.runOrder.get(a) ?? 0))
      .map(([, r]) => r);
  }
}

/** SQLite ORDER BY semantics: NULLs first, then binary string order. */
function cmp(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
