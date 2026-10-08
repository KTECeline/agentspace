import type { AgentSpaceEvent } from "@agentspace/spec-types";
import type { ApprovalEvidence } from "../replay";

/** A bundled recording (`make record`). /demo plays it with the ReplayPlayer (sources/replay.ts). */

export interface Recording {
  format: "agentspace-recording";
  version: 1;
  name: string;
  run_id: string;
  events: AgentSpaceEvent[];
  /** Review evidence the collector attached to the run's approvals (D-045). Optional. */
  approvals?: ApprovalEvidence;
}
