import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { Projector } from "../lib/projector";

const dir = fileURLToPath(new URL("../../spec/v0.1/examples/", import.meta.url));

describe("Projector", () => {
  it("matches the collector's projections (projection.expected.json)", () => {
    const input = readFileSync(dir + "projection.input.jsonl", "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AgentSpaceEvent);
    const expected = JSON.parse(readFileSync(dir + "projection.expected.json", "utf8")) as Record<string, { agents: unknown[]; runs: { run_id: string }[] }>;

    const p = new Projector();
    input.forEach((e) => p.apply(e));
    for (const [ws, exp] of Object.entries(expected)) {
      expect(p.agentList(ws)).toEqual(exp.agents);
      const runs = p.runList(ws).sort((a, b) => a.run_id.localeCompare(b.run_id));
      expect(runs).toEqual(exp.runs);
    }
  });
});
