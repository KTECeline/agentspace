import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const examples = fileURLToPath(new URL("../../spec/v0.1/examples/", import.meta.url));

export function fixture(name: "valid.jsonl" | "invalid.jsonl"): Record<string, unknown>[] {
  return readFileSync(examples + name, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export async function makeApp() {
  const store = new Store(":memory:");
  const app = await buildApp({ config: loadConfig({}), store, logger: false });
  return { app, store };
}

let n = 0;
export function ev(partial: Partial<AgentSpaceEvent> & Pick<AgentSpaceEvent, "type" | "data">): AgentSpaceEvent {
  n += 1;
  return {
    spec_version: "0.1",
    id: `t${n}-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    workspace: "default",
    run_id: "run-1",
    agent_id: null,
    team_id: null,
    parent_id: null,
    ...partial,
  } as AgentSpaceEvent;
}
