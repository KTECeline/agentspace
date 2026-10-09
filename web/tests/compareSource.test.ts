import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareRuns, pickBaseline } from "@/lib/compare";
import { buildTimeline } from "@/lib/replay";
import { recordingSource } from "@/lib/compareSource";
import { RECORDINGS } from "@/lib/recordings";
import type { Recording } from "@/lib/sources/recorded";

const load = async (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../public${file}`, import.meta.url)), "utf8")) as Recording;

describe("recordingSource (/demo/compare)", () => {
  it("lists one projected run per recording, newest first, and never needs a collector", async () => {
    const src = recordingSource(RECORDINGS, load);
    expect(src.collector).toBeNull();
    const runs = await src.runs(null);
    expect(runs).toHaveLength(RECORDINGS.length);
    expect(runs.every((r) => r.status !== "running" && r.event_count > 10)).toBe(true);
    const starts = runs.map((r) => r.started_at ?? "");
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it("serves a run's events and links into /demo, paused on an event", async () => {
    const src = recordingSource(RECORDINGS, load);
    const runs = await src.runs(null);
    const devTeam = (await load(RECORDINGS.find((r) => r.id === "dev-team")!.file)).run_id;
    expect(runs.some((r) => r.run_id === devTeam)).toBe(true);
    const { events, truncated } = await src.events(devTeam, null);
    expect(truncated).toBe(false);
    expect(src.replayHref(devTeam, events[3]!.id)).toBe(`/demo?scenario=dev-team&event=${events[3]!.id}`);
    await expect(src.events("nope", null)).rejects.toThrow(/no recording/);
  });

  it("loads each recording once", async () => {
    let calls = 0;
    const src = recordingSource(RECORDINGS, (f) => (calls++, load(f)));
    await src.runs(null);
    await src.events((await load(RECORDINGS[0]!.file)).run_id, null);
    expect(calls).toBe(RECORDINGS.length);
  });

  it("tells the failure story: the bad run, its good baseline, and what changed", async () => {
    const src = recordingSource(RECORDINGS, load);
    const runs = await src.runs(null);
    const bad = runs.find((r) => r.status === "error")!; // what /demo/compare opens on
    const good = pickBaseline(runs, bad)!;
    expect(good.run_id).toBe((await load("/recordings/story-good.json")).run_id);
    const [a, b] = await Promise.all([src.events(good.run_id, null), src.events(bad.run_id, null)]);
    const c = compareRuns(buildTimeline(a.events).events, buildTimeline(b.events).events);
    expect([c.a.status, c.b.status]).toEqual(["ok", "error"]);
    expect(c.pathChanged).toBe(false); // same agents, same order: the difference is inside a step
    expect(c.b.tools.run_tests).toMatchObject({ failed: 3 });
    expect([c.a.findings, c.b.findings]).toEqual([0, 3]);
    expect(c.b.approvals).toBe(1);
    expect(c.divergence).not.toBeNull();
  });
});
