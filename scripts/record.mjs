#!/usr/bin/env node
// Save a run from the collector as a recording the web app can replay with no collector.
//   node scripts/record.mjs [--run <run_id>] [--workspace default] [--out web/public/recordings/dev-team.json] [--name "..."]
// Without --run, the most recent finished run is used.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: process.env.AGENTSPACE_URL ?? "http://localhost:4800" },
    workspace: { type: "string", default: "default" },
    run: { type: "string" },
    out: { type: "string", default: "web/public/recordings/dev-team.json" },
    name: { type: "string", default: "LangGraph dev team fixes a bug" },
  },
});

const base = `${args.url.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(args.workspace)}`;
const get = async (path) => {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};

let runId = args.run;
if (!runId) {
  const runs = await get("/runs?limit=50");
  const finished = runs.filter((r) => r.status !== "running");
  if (!finished.length) throw new Error("no finished runs in this workspace");
  runId = finished.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0].run_id;
}

const events = [];
let after = 0;
for (;;) {
  const page = await get(`/runs/${runId}/events?after=${after}&limit=5000`);
  if (!page.length) break;
  events.push(...page);
  after = page.at(-1).seq;
}
// Strip collector-specific fields (the player assigns its own seq numbers) and order by event
// time: OTLP spans arrive when they *end*, so arrival order isn't time order.
const clean = events
  .map(({ seq: _seq, ...e }) => e)
  .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
const recording = { format: "agentspace-recording", version: 1, name: args.name, run_id: runId, events: clean };
writeFileSync(args.out, JSON.stringify(recording) + "\n");
console.log(`recorded run ${runId}: ${clean.length} events -> ${args.out}`);
