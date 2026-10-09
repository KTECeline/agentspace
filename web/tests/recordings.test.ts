import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsServerMessage } from "@agentspace/spec-types";
import { RECORDINGS, recordingById } from "../lib/recordings";
import { buildTimeline } from "../lib/replay";
import type { Recording } from "../lib/sources/recorded";
import { ReplayPlayer } from "../lib/sources/replay";
import { emptyState, reduce, type OfficeState } from "../lib/state";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bundled recordings", () => {
  it.each(RECORDINGS)("$id replays to a finished run with every agent in a room and at rest", (info) => {
    const rec = JSON.parse(readFileSync(fileURLToPath(new URL(`../public${info.file}`, import.meta.url)), "utf8")) as Recording;
    expect(rec.format).toBe("agentspace-recording");
    expect(rec.events.length).toBeGreaterThan(10);
    let state: OfficeState = emptyState;
    const stop = new ReplayPlayer(buildTimeline(rec.events), "demo", { speed: 16 }).source({
      send: (m: WsServerMessage) => void (state = reduce(state, m)),
      setConnection: () => {},
    });
    vi.advanceTimersByTime(120_000);
    stop();
    const agents = Object.values(state.agents);
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.every((a) => a.team_id)).toBe(true);
    // The failure story ends in an error on purpose; every other recording ends ok.
    const expected = info.id === "story" ? "error" : "ok";
    expect(Object.values(state.runs).map((r) => r.status)).toEqual([expected]);
    expect(agents.every((a) => a.status === "done" || a.status === "error")).toBe(true);
  });

  it.each(RECORDINGS)("$id carries the evidence for every policy review", (info) => {
    const rec = JSON.parse(readFileSync(fileURLToPath(new URL(`../public${info.file}`, import.meta.url)), "utf8")) as Recording;
    const reviews = rec.events.filter((e) => e.type === "approval.requested" && e.data.policy).map((e) => (e.data as { approval_id: string }).approval_id);
    const withEvidence = new Set((rec.approvals ?? []).filter((a) => a.context).map((a) => a.approval_id));
    expect(reviews.filter((id) => !withEvidence.has(id))).toEqual([]);
  });

  it("falls back to the first recording for unknown ids", () => {
    expect(recordingById("nope").id).toBe("story");
    expect(recordingById(undefined).id).toBe("story");
  });
});
