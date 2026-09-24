import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { SqliteStore } from "../src/store/index.js";

/**
 * Projection conformance: the collector's SQL projections define the expected agent/run state.
 * The web app's client-side projector (used for recordings) is tested against the same file.
 * If you change projection rules: delete projection.expected.json, re-run, review the diff.
 */
const dir = fileURLToPath(new URL("../../spec/v0.1/examples/", import.meta.url));
const input = readFileSync(dir + "projection.input.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as AgentSpaceEvent);

describe("projection conformance", () => {
  it("matches projection.expected.json", async () => {
    const store = new SqliteStore(":memory:");
    for (let i = 0; i < input.length; i += 7) await store.insert(input.slice(i, i + 7)); // several batches
    const workspaces = [...new Set(input.map((e) => e.workspace))].sort();
    const actual: Record<string, unknown> = {};
    for (const ws of workspaces) {
      actual[ws] = {
        agents: await store.agents(ws),
        runs: (await store.runs(ws, 500)).sort((a, b) => a.run_id.localeCompare(b.run_id)),
      };
    }
    const path = dir + "projection.expected.json";
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(actual, null, 1) + "\n");
    expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    await store.close();
  });
});
