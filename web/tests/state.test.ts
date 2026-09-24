import { describe, expect, it } from "vitest";
import type { AgentState, RunState, StoredEvent } from "@agentspace/spec-types";
import { MAX_EVENTS, emptyState, groupByTeam, latestRun, reduce } from "../lib/state";
import { costInfo, describe as describeEvent, formatCost, formatDuration, teamLabel, timeAgo } from "../lib/format";

const agent = (id: string, team: string | null, name = id): AgentState => ({
  workspace: "default",
  agent_id: id,
  team_id: team,
  name,
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
  cost_estimated_usd: 0,
  unpriced_calls: 0,
  model: null,
});

const event = (seq: number, extra: Partial<StoredEvent> = {}): StoredEvent =>
  ({
    seq,
    spec_version: "0.1",
    id: `e${seq}`,
    type: "message",
    ts: "2026-09-24T10:00:00.000Z",
    workspace: "default",
    run_id: "r",
    agent_id: "a",
    team_id: null,
    parent_id: null,
    data: {},
    ...extra,
  }) as StoredEvent;

describe("reduce", () => {
  it("replaces state on snapshot and appends new events only", () => {
    let s = reduce(emptyState, { type: "snapshot", workspace: "default", agents: [agent("a", "t")], runs: [], events: [event(1), event(2)], approvals: [] });
    expect(s.ready).toBe(true);
    s = reduce(s, { type: "events", events: [event(2), event(3)] }); // 2 is a replay after reconnect
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("caps the event buffer", () => {
    const many = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => event(i + 1));
    const s = reduce(emptyState, { type: "events", events: many });
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect(s.events[0]!.seq).toBe(51);
  });

  it("upserts agents and runs", () => {
    let s = reduce(emptyState, { type: "agents", agents: [agent("a", "t")] });
    s = reduce(s, { type: "agents", agents: [{ ...agent("a", "t"), status: "thinking" }, agent("b", "t")] });
    expect(Object.keys(s.agents)).toEqual(["a", "b"]);
    expect(s.agents.a!.status).toBe("thinking");
    const run = { run_id: "r1", started_at: "2026-01-01" } as RunState;
    const run2 = { run_id: "r2", started_at: "2026-02-01" } as RunState;
    s = reduce(s, { type: "runs", runs: [run, run2] });
    expect(latestRun(s.runs)?.run_id).toBe("r2");
  });
});

describe("groupByTeam", () => {
  it("sorts teams, puts unassigned last, sorts agents by name", () => {
    const teams = groupByTeam([agent("z", "eng", "Zed"), agent("x", null), agent("a", "eng", "Amy"), agent("q", "design")]);
    expect(teams.map((t) => t.id)).toEqual(["design", "eng", ""]);
    expect(teams[1]!.agents.map((a) => a.name)).toEqual(["Amy", "Zed"]);
  });
});

describe("format", () => {
  it("describes events", () => {
    expect(describeEvent(event(1, { type: "handoff", data: { from_agent_id: "a", to_agent_id: "b" } } as Partial<StoredEvent>))).toBe("Handed off to b");
    expect(describeEvent(event(1, { type: "llm.call", summary: "chose tool: x", tokens_in: 5, tokens_out: 2, data: {} } as Partial<StoredEvent>))).toBe(
      "chose tool: x · 5→2 tok",
    );
    expect(describeEvent(event(1, { type: "agent.status", data: { status: "waiting_human" } } as Partial<StoredEvent>))).toBe("Needs you");
  });

  it("formats numbers and labels", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatCost(0.0039)).toBe("$0.0039");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(teamLabel("dev-team")).toBe("Dev Team");
    expect(teamLabel("")).toBe("Unassigned");
    expect(timeAgo("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:30Z"))).toBe("30s ago");
  });
});

describe("costInfo", () => {
  const t = (cost_usd: number, cost_estimated_usd = 0, unpriced_calls = 0) => ({ cost_usd, cost_estimated_usd, unpriced_calls });

  it("marks estimated costs and explains mixed ones", () => {
    expect(costInfo(t(0.5))).toEqual({ text: "$0.50", estimated: false, note: null });
    expect(costInfo(t(0.5, 0.5))).toEqual({ text: "$0.50", estimated: true, note: "Estimated from list prices." });
    expect(costInfo(t(0.5, 0.2)).note).toBe("$0.20 estimated from list prices, $0.30 reported by the framework.");
  });

  it("says when calls could not be priced", () => {
    expect(costInfo(t(0, 0, 1))).toEqual({ text: "$0", estimated: false, note: "1 model call has no price (model not in the price table)." });
    expect(costInfo(t(0.01, 0.01, 3)).note).toBe("Estimated from list prices. 3 model calls have no price (model not in the price table).");
  });
});
