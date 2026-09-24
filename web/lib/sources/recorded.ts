import type { AgentSpaceEvent } from "@agentspace/spec-types";

/** A bundled recording (`make record`). /demo plays it with the ReplayPlayer (sources/replay.ts). */

export interface Recording {
  format: "agentspace-recording";
  version: 1;
  name: string;
  run_id: string;
  events: AgentSpaceEvent[];
}
