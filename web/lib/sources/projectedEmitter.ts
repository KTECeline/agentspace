import type { AgentSpaceEvent, StoredEvent, WsServerMessage } from "@agentspace/spec-types";
import { Projector } from "../projector";

/**
 * Turns raw events into the same message stream the collector sends (events + agents + runs
 * deltas), using the client-side Projector. Shared by recorded and synthetic sources.
 */
export class ProjectedEmitter {
  private projector = new Projector();
  private seq = 0;

  constructor(private workspace: string) {}

  snapshot(): WsServerMessage {
    this.projector = new Projector();
    return { type: "snapshot", workspace: this.workspace, agents: [], runs: [], events: [], approvals: [] };
  }

  emit(events: AgentSpaceEvent[]): WsServerMessage[] {
    const stored: StoredEvent[] = [];
    const agents = new Map<string, ReturnType<Projector["apply"]>["agent"]>();
    const runs = new Map<string, ReturnType<Projector["apply"]>["run"]>();
    for (const raw of events) {
      const ev = { ...raw, workspace: this.workspace } as AgentSpaceEvent;
      const { agent, run } = this.projector.apply(ev);
      stored.push({ ...ev, seq: ++this.seq });
      if (agent) agents.set(agent.agent_id, agent);
      runs.set(run.run_id, run);
    }
    const out: WsServerMessage[] = [{ type: "events", events: stored }];
    if (agents.size) out.push({ type: "agents", agents: [...agents.values()].filter((a) => a !== undefined) });
    out.push({ type: "runs", runs: [...runs.values()] });
    return out;
  }
}
