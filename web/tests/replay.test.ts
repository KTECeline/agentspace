import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSpaceEvent, WsServerMessage } from "@agentspace/spec-types";
import { Projector } from "../lib/projector";
import { approvalsFrom, buildTimeline, countAt, findMarker, snapshotAt } from "../lib/replay";
import { ReplayPlayer } from "../lib/sources/replay";
import { emptyState, reduce } from "../lib/state";

const recording = JSON.parse(readFileSync(fileURLToPath(new URL("../public/recordings/dev-team.json", import.meta.url)), "utf8")) as {
  events: AgentSpaceEvent[];
};

let n = 0;
function ev(type: string, sec: number, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}): AgentSpaceEvent {
  n += 1;
  return {
    spec_version: "0.1",
    id: `e${n}`,
    type,
    ts: new Date(Date.UTC(2026, 8, 24, 10, 0, sec)).toISOString(),
    workspace: "default",
    run_id: "r1",
    agent_id: null,
    team_id: null,
    parent_id: null,
    data,
    ...extra,
  } as AgentSpaceEvent;
}

describe("buildTimeline", () => {
  const events = [
    ev("run.started", 0, {}, { name: "r" }),
    ev("agent.status", 2, { agent_id: "b" }, { status: "thinking" }),
    ev("agent.status", 1, { agent_id: "a" }, { status: "thinking" }), // arrives late: sorted by time
    ev("handoff", 3, { agent_id: "a" }, { from_agent_id: "a", to_agent_id: "c" }),
    ev("approval.requested", 600, { agent_id: "c" }, { approval_id: "ap", reason: "Ship?" }), // a 10 minute wait
    ev("approval.resolved", 601, { agent_id: "c" }, { approval_id: "ap", decision: "approved", resolved_by: "sam" }),
    ev("run.control", 602, {}, { action: "pause", by: "sam" }),
    ev("error", 603, { agent_id: "c" }, { message: "boom" }),
    ev("run.finished", 604, {}, { status: "error" }),
  ];
  const tl = buildTimeline(events);

  it("orders by time and squashes long idle gaps", () => {
    expect(tl.events.map((e) => e.agent_id ?? "-")).toEqual(["-", "a", "b", "a", "c", "c", "-", "c", "-"]);
    expect(tl.times).toEqual([0, 1000, 2000, 3000, 6000, 7000, 8000, 9000, 10000]);
    expect(tl.duration).toBe(10_000);
    expect(tl.agentOrder).toEqual(["a", "b", "c"]);
  });

  it("marks errors, handoffs, approvals and run controls", () => {
    expect(tl.markers.map((m) => [m.kind, m.at, m.label])).toEqual([
      ["handoff", 3000, "Handoff a → c"],
      ["approval", 6000, "Approval asked: Ship?"],
      ["approval", 7000, "Approval approved by sam"],
      ["control", 8000, "Run paused by sam"],
      ["error", 9000, "Error: boom"],
      ["error", 10000, "Run failed"],
    ]);
    expect(findMarker(tl, 0, "error", 1)?.at).toBe(9000);
    expect(findMarker(tl, 9000, "error", 1)?.at).toBe(10000);
    expect(findMarker(tl, 3100, "handoff", 1)).toBeUndefined();
    expect(findMarker(tl, 7100, null, -1)?.at).toBe(6000); // just after a marker: skip it
    expect(findMarker(tl, 7500, null, -1)?.at).toBe(7000);
  });

  it("counts events at a time", () => {
    expect([countAt(tl, -1), countAt(tl, 0), countAt(tl, 2500), countAt(tl, 10_000)]).toEqual([0, 1, 3, 9]);
  });

  it("rebuilds approvals from their events", () => {
    expect(approvalsFrom(tl.events.slice(0, 5)).map((a) => a.status)).toEqual(["pending"]);
    expect(approvalsFrom(tl.events)[0]).toMatchObject({ status: "approved", resolved_by: "sam", reason: "Ship?" });
  });
});

describe("snapshotAt", () => {
  const tl = buildTimeline(recording.events);

  it("at the end equals projecting every event, with agents in first-seen order", () => {
    const { message } = snapshotAt(tl, tl.events.length, "demo");
    if (message.type !== "snapshot") throw new Error("expected a snapshot");
    const p = new Projector();
    tl.events.forEach((e) => p.apply({ ...e, workspace: "demo" }));
    expect(new Set(message.agents.map((a) => a.agent_id))).toEqual(new Set(p.agentList("demo").map((a) => a.agent_id)));
    expect(message.agents.map((a) => a.agent_id)).toEqual(tl.agentOrder);
    expect(message.runs).toEqual(p.runList("demo"));
    expect(message.events.at(-1)?.seq).toBe(tl.events.length);
  });

  it("partway through only knows what had happened", () => {
    const { message } = snapshotAt(tl, 3, "demo");
    if (message.type !== "snapshot") throw new Error("expected a snapshot");
    expect(message.events).toHaveLength(3);
    expect(message.agents.length).toBeLessThanOrEqual(tl.agentOrder.length);
  });
});

describe("ReplayPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function attach(player: ReplayPlayer) {
    let state = emptyState;
    const sent: WsServerMessage[] = [];
    const connections: string[] = [];
    const stop = player.source({
      send: (m) => {
        sent.push(m);
        state = reduce(state, m);
      },
      setConnection: (c) => connections.push(c),
    });
    return { sent, connections, stop, state: () => state };
  }

  it("plays to the end at the chosen speed, ending in the same state as the collector would", () => {
    const tl = buildTimeline(recording.events);
    const player = new ReplayPlayer(tl, "demo", { speed: 16 });
    const { connections, state, stop } = attach(player);
    expect(connections).toEqual(["replay"]);
    expect(player.getStatus().playing).toBe(true);
    vi.advanceTimersByTime(tl.duration / 16 + 200);
    expect(player.getStatus()).toMatchObject({ playing: false, position: tl.duration, count: tl.events.length });
    const p = new Projector();
    tl.events.forEach((e) => p.apply({ ...e, workspace: "demo" }));
    expect(Object.values(state().runs)).toEqual(p.runList("demo"));
    expect(state().events).toHaveLength(tl.events.length);
    stop();
  });

  it("seeks backwards and forwards with one snapshot each, and keeps playing from there", () => {
    const tl = buildTimeline(recording.events);
    const player = new ReplayPlayer(tl, "demo", { autoplay: false });
    const { sent, state } = attach(player);
    player.seek(tl.duration);
    vi.advanceTimersByTime(20);
    expect(state().events).toHaveLength(tl.events.length);
    const before = sent.length;
    player.seek(tl.times[1]!); // a drag: only the last position is projected
    player.seek(tl.times[4]!);
    vi.advanceTimersByTime(20);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.type).toBe("snapshot");
    expect(state().events).toHaveLength(countAt(tl, tl.times[4]!)); // events at the same moment come together
    player.play();
    vi.advanceTimersByTime(tl.duration + 200);
    expect(state().events).toHaveLength(tl.events.length);
  });

  it("loops recordings after a pause", () => {
    const tl = buildTimeline(recording.events.slice(0, 10));
    const player = new ReplayPlayer(tl, "demo", { loop: true, connection: "recording" });
    const { connections, state } = attach(player);
    expect(connections).toEqual(["recording"]);
    vi.advanceTimersByTime(tl.duration + 100);
    const desks = state().firstSeen;
    expect(Object.keys(desks).length).toBeGreaterThan(0);
    expect(player.getStatus().playing).toBe(false);
    vi.advanceTimersByTime(2500);
    expect(player.getStatus().playing).toBe(true);
    expect(player.getStatus().position).toBeLessThan(200); // started over
    expect(state().firstSeen).toEqual(desks); // nobody left their desk
  });
});
