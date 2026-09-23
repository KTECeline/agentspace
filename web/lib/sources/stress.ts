import type { AgentSpaceEvent, AgentStatus } from "@agentspace/spec-types";
import { ProjectedEmitter } from "./projectedEmitter";
import type { Source } from "./types";

const TEAMS = ["research", "engineering", "support", "design", "data", "ops", "growth", "legal"];
const TOOLS = ["web_search", "read_file", "run_tests", "sql_query", "send_email", "write_file"];
const STATUSES: AgentStatus[] = ["thinking", "thinking", "using_tool", "using_tool", "idle", "waiting", "done", "waiting_human", "error"];

/** Deterministic PRNG so stress runs are repeatable. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic load: `agents` agents spread over teams, emitting `rate` events per second. */
export function stressSource(agents = 50, rate = 100, seed = 42): Source {
  return (sink) => {
    const rand = mulberry32(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const emitter = new ProjectedEmitter("stress");
    const runId = "stress-run";
    const teamCount = Math.min(TEAMS.length, Math.max(1, Math.ceil(agents / 7)));
    const roster = Array.from({ length: agents }, (_, i) => ({ id: `agent-${String(i + 1).padStart(2, "0")}`, team: TEAMS[i % teamCount]! }));
    let n = 0;
    const base = (agent: (typeof roster)[number], type: string, data: object, extra: object = {}) =>
      ({
        spec_version: "0.1",
        id: `s${++n}`,
        type,
        ts: new Date().toISOString(),
        workspace: "stress",
        run_id: runId,
        agent_id: agent.id,
        team_id: agent.team,
        parent_id: null,
        data,
        ...extra,
      }) as AgentSpaceEvent;

    sink.setConnection("recording");
    sink.send(emitter.snapshot());
    const intro: AgentSpaceEvent[] = [
      { ...base(roster[0]!, "run.started", { name: "stress test", framework: "synthetic" }), agent_id: null, team_id: null } as AgentSpaceEvent,
      ...roster.map((a, i) => base(a, "agent.registered", { name: `Agent ${i + 1}`, role: a.team, framework: "synthetic" })),
    ];
    emitter.emit(intro).forEach(sink.send);

    const next = (): AgentSpaceEvent => {
      const a = pick(roster);
      const r = rand();
      if (r < 0.45) return base(a, "agent.status", { status: pick(STATUSES) });
      if (r < 0.7) {
        const tin = Math.floor(200 + rand() * 2000);
        return base(a, "llm.call", { provider: "synthetic", operation: "chat", duration_ms: Math.floor(300 + rand() * 1500) }, {
          tokens_in: tin,
          tokens_out: Math.floor(tin / 10),
          cost_usd: tin * 3e-6,
          model: "synthetic-model",
          summary: "thought about it",
        });
      }
      if (r < 0.9) {
        const tool = pick(TOOLS);
        return base(a, rand() < 0.5 ? "tool.call" : "tool.result", { tool_name: tool, call_id: `c${n}`, ok: rand() > 0.05 }, { summary: `${tool}()` });
      }
      const to = pick(roster);
      return base(a, "handoff", { from_agent_id: a.id, to_agent_id: to.id }, { summary: `handed off to ${to.id}` });
    };

    // Emit in 20 ms slices to hit the target rate smoothly.
    const perSlice = rate / 50;
    let carry = 0;
    const timer = setInterval(() => {
      carry += perSlice;
      const count = Math.floor(carry);
      carry -= count;
      if (count) emitter.emit(Array.from({ length: count }, next)).forEach(sink.send);
    }, 20);
    return () => clearInterval(timer);
  };
}
