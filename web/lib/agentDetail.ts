import type { StoredEvent } from "@agentspace/spec-types";

export interface CurrentStep {
  stepId: string;
  name: string;
  startedAt: string;
}

/** The innermost step this agent started and hasn't finished yet (null if idle). */
export function currentStep(events: StoredEvent[], agentId: string): CurrentStep | null {
  const finished = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.agent_id !== agentId) continue;
    if (e.type === "step.finished") finished.add(e.data.step_id);
    else if (e.type === "step.started" && !finished.has(e.data.step_id)) {
      return { stepId: e.data.step_id, name: e.data.name, startedAt: e.ts };
    }
  }
  return null;
}

export interface ToolCall {
  callId: string;
  tool: string;
  startedAt: string;
  state: "running" | "ok" | "failed";
  durationMs: number | null;
  error: string | null;
}

/** Tool calls paired with their results, newest first. */
export function toolCalls(events: StoredEvent[], agentId: string, limit = 12): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const e of events) {
    if (e.agent_id !== agentId) continue;
    if (e.type === "tool.call") {
      byId.set(e.data.call_id, { callId: e.data.call_id, tool: e.data.tool_name, startedAt: e.ts, state: "running", durationMs: null, error: null });
    } else if (e.type === "tool.result") {
      const prev = byId.get(e.data.call_id);
      byId.set(e.data.call_id, {
        callId: e.data.call_id,
        tool: e.data.tool_name,
        startedAt: prev?.startedAt ?? e.ts,
        state: e.data.ok ? "ok" : "failed",
        durationMs: e.data.duration_ms ?? null,
        error: e.data.error ?? null,
      });
    }
  }
  return [...byId.values()].reverse().slice(0, limit);
}
