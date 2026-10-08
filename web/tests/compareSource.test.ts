import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
    const devTeam = (await load(RECORDINGS[0]!.file)).run_id;
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
});
