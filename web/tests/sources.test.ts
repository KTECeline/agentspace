import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsServerMessage } from "@agentspace/spec-types";
import { recordedSource, schedule, type Recording } from "../lib/sources/recorded";
import { stressSource } from "../lib/sources/stress";
import { emptyState, reduce, type OfficeState } from "../lib/state";

const recording = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/recordings/dev-team.json", import.meta.url)), "utf8"),
) as Recording;

function collect() {
  const msgs: WsServerMessage[] = [];
  let state: OfficeState = emptyState;
  const sink = {
    send: (m: WsServerMessage) => {
      msgs.push(m);
      state = reduce(state, m);
    },
    setConnection: vi.fn(),
  };
  return { msgs, sink, state: () => state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("recorded source", () => {
  it("schedules events relative to the first one and squashes long gaps", () => {
    const t = schedule(
      [
        { ts: "2026-01-01T00:00:00.000Z" },
        { ts: "2026-01-01T00:00:01.000Z" },
        { ts: "2026-01-01T00:01:00.000Z" },
      ] as never,
      2,
      4000,
    );
    expect(t.map((x) => x.at)).toEqual([0, 500, 2500]);
  });

  it("replays the dev-team run into the same final state the collector produced", () => {
    const { sink, state } = collect();
    const stop = recordedSource(recording, "demo", { loop: false })(sink);
    vi.advanceTimersByTime(60_000);
    stop();
    const s = state();
    expect(Object.keys(s.agents).sort()).toEqual(["engineer", "manager", "triage"]);
    expect(Object.values(s.agents).every((a) => a.status === "done" && a.team_id === "engineering")).toBe(true);
    expect(s.events).toHaveLength(recording.events.length);
    expect(s.handoffs.length).toBe(4);
    const run = Object.values(s.runs)[0]!;
    expect(run.status).toBe("ok");
    expect(sink.setConnection).toHaveBeenCalledWith("recording");
  });

  it("loops with fresh ids and resets between loops", () => {
    const { sink, state, msgs } = collect();
    const stop = recordedSource(recording, "demo", { loop: true, gapMs: 1000 })(sink);
    vi.advanceTimersByTime(60_000);
    stop();
    expect(msgs.filter((m) => m.type === "snapshot").length).toBeGreaterThan(1);
    expect(Object.keys(state().runs).every((id) => id.includes("-"))).toBe(true);
  });
});

describe("stress source", () => {
  it("registers every agent and hits the target event rate", () => {
    const { sink, state } = collect();
    const stop = stressSource(50, 100)(sink);
    vi.advanceTimersByTime(10_000);
    stop();
    const s = state();
    expect(Object.keys(s.agents)).toHaveLength(50);
    const generated = s.events.length; // capped at MAX_EVENTS
    expect(generated).toBe(500);
    const total = Object.values(s.runs)[0]!.event_count;
    expect(total).toBeGreaterThanOrEqual(1000 + 51 - 5); // ~100/s for 10 s, plus intro
    expect(total).toBeLessThanOrEqual(1000 + 51 + 5);
    expect(new Set(Object.values(s.agents).map((a) => a.team_id)).size).toBe(8);
  });
});
