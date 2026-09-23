import type { AgentStatus, StoredEvent } from "@agentspace/spec-types";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Idle",
  thinking: "Thinking",
  using_tool: "Using tool",
  waiting: "Waiting",
  blocked: "Blocked",
  waiting_human: "Needs you",
  done: "Done",
  error: "Error",
};

/** One-line, human description of an event for the log. */
export function describe(e: StoredEvent): string {
  switch (e.type) {
    case "run.started":
      return `Run started${e.data.name ? `: ${e.data.name}` : ""}`;
    case "run.finished":
      return `Run ${e.data.status}${e.data.duration_ms != null ? ` in ${formatDuration(e.data.duration_ms)}` : ""}`;
    case "agent.registered":
      return `Joined${e.data.role ? ` as ${e.data.role}` : ""}`;
    case "agent.status":
      return STATUS_LABEL[e.data.status] + (e.data.detail ? ` · ${e.data.detail}` : "");
    case "step.started":
      return `Started ${e.data.name}`;
    case "step.finished":
      return `${e.data.ok ? "Finished" : "Failed"} ${e.data.name}${e.data.duration_ms != null ? ` (${formatDuration(e.data.duration_ms)})` : ""}`;
    case "llm.call": {
      const tokens = e.tokens_in != null || e.tokens_out != null ? ` · ${e.tokens_in ?? 0}→${e.tokens_out ?? 0} tok` : "";
      return `${e.summary ?? "LLM call"}${tokens}`;
    }
    case "tool.call":
      return `Calling ${e.data.tool_name}`;
    case "tool.result":
      return `${e.data.tool_name} ${e.data.ok ? "returned" : "failed"}${e.data.duration_ms != null ? ` (${formatDuration(e.data.duration_ms)})` : ""}`;
    case "handoff":
      return `Handed off to ${e.data.to_agent_id}${e.data.reason ? `: ${e.data.reason}` : ""}`;
    case "message":
      return e.summary ?? "Message";
    case "approval.requested":
      return `Needs approval: ${e.data.reason}`;
    case "approval.resolved":
      return `Approval ${e.data.decision}${e.data.comment ? `: ${e.data.comment}` : ""}`;
    case "error":
      return `${e.data.kind ? `${e.data.kind}: ` : ""}${e.data.message}`;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US");
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export function teamLabel(id: string): string {
  if (!id) return "Unassigned";
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
