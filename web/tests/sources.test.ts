import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsServerMessage } from "@agentspace/spec-types";
import { stressSource } from "../lib/sources/stress";
import { emptyState, reduce, type OfficeState } from "../lib/state";

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
