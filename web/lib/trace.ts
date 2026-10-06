import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { usageOf, type Usage } from "./projector";

/**
 * Run inspector model (pure, tested in tests/trace.test.ts): a run's events as a tree.
 *
 * - `step.started`/`step.finished` pairs (by `step_id`) and `tool.call`/`tool.result` pairs
 *   (by `call_id`) become one node each, and so do `approval.requested`/`approval.resolved`.
 * - Children hang off their `parent_id`. An event with no known parent goes under the innermost
 *   step or tool of the same agent open at that moment, marked `inferred` (some adapters emit
 *   approvals without a parent). A step with no parent is top level: adapters set it when nested.
 * - `agent.status`, `agent.registered` and the run's own start/finish are not nodes.
 *
 * Indices are positions in the input array, which should be `Timeline.events` (sorted by time),
 * so a node maps straight onto the replay scrubber.
 */

export type TraceKind = "run" | "step" | "tool" | "llm" | "handoff" | "approval" | "message" | "error" | "control";
/** `none`: nothing to judge (a model call, a handoff, an approval that was rejected). */
export type TraceStatus = "ok" | "error" | "open" | "none";

export interface TraceNode {
  id: string;
  kind: TraceKind;
  label: string;
  agentId: string | null;
  parentId: string | null;
  depth: number;
  /** Index of the first and last event folded into this node. Open containers run to the end. */
  start: number;
  end: number;
  durationMs: number | null;
  status: TraceStatus;
  error: string | null;
  /** Placed by time and agent, not by `parent_id`. */
  inferred: boolean;
  children: TraceNode[];
  /** This node and everything under it (the totals rule: `llm.call` only). */
  usage: Usage;
  llmCalls: number;
  toolCalls: number;
  /** This node or a descendant failed. */
  hasError: boolean;
}

export interface Trace {
  root: TraceNode;
  byId: Map<string, TraceNode>;
  /** Pre-order (the order a fully expanded tree shows them). */
  flat: TraceNode[];
  /** The earliest thing that went wrong (first to finish failing, then deepest), if anything did. */
  firstError: TraceNode | null;
}

const ZERO: Usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0, cost_estimated_usd: 0, unpriced_calls: 0 };

export function buildTrace(events: AgentSpaceEvent[]): Trace {
  const last = Math.max(0, events.length - 1);
  const root = node("run", "run", "Run", null, 0);
  root.end = last;
  root.status = "open";
  const byId = new Map<string, TraceNode>([[root.id, root]]);
  // Open steps and tool calls per agent, innermost last, for events that carry no parent.
  const open = new Map<string, TraceNode[]>();

  const attach = (n: TraceNode, e: AgentSpaceEvent, inferParent: boolean): void => {
    let parent = e.parent_id ? byId.get(`step:${e.parent_id}`) : undefined;
    if (!parent && inferParent && e.agent_id) {
      parent = open.get(e.agent_id)?.at(-1);
      if (parent) n.inferred = true;
    }
    parent ??= root;
    n.parentId = parent.id;
    parent.children.push(n);
    byId.set(n.id, n);
  };
  const push = (n: TraceNode): void => {
    if (!n.agentId) return;
    const stack = open.get(n.agentId) ?? [];
    stack.push(n);
    open.set(n.agentId, stack);
  };
  const close = (n: TraceNode, i: number, e: AgentSpaceEvent, ok: boolean | null, error: string | null, durationMs: number | undefined): void => {
    n.end = i;
    n.status = ok === null ? "none" : ok ? "ok" : "error";
    n.error = error;
    n.durationMs = durationMs ?? Date.parse(e.ts) - Date.parse(events[n.start]!.ts);
    if (n.agentId) {
      const stack = open.get(n.agentId);
      const at = stack?.lastIndexOf(n) ?? -1;
      if (stack && at >= 0) stack.splice(at, 1);
    }
  };

  events.forEach((e, i) => {
    switch (e.type) {
      case "run.started":
        root.label = e.data.name ?? e.summary ?? "Run";
        return;
      case "run.finished":
        root.end = i;
        root.status = e.data.status === "ok" ? "ok" : e.data.status === "error" ? "error" : "none";
        root.error = e.data.status === "error" ? (e.summary ?? "Run failed") : null;
        root.durationMs = e.data.duration_ms ?? Date.parse(e.ts) - Date.parse(events[0]!.ts);
        return;
      case "step.started": {
        const n = node(`step:${e.data.step_id}`, "step", e.data.name, e.agent_id, i);
        attach(n, e, false);
        push(n);
        return;
      }
      case "step.finished": {
        let n = byId.get(`step:${e.data.step_id}`);
        if (!n) {
          // The start is missing (cut off, or dropped by the SDK): keep the step as a point.
          n = node(`step:${e.data.step_id}`, "step", e.data.name, e.agent_id, i);
          attach(n, e, false);
        }
        close(n, i, e, e.data.ok, e.data.error ?? null, e.data.duration_ms);
        return;
      }
      case "tool.call": {
        const n = node(`tool:${e.data.call_id}`, "tool", e.data.tool_name, e.agent_id, i);
        attach(n, e, true);
        push(n);
        return;
      }
      case "tool.result": {
        let n = byId.get(`tool:${e.data.call_id}`);
        if (!n) {
          n = node(`tool:${e.data.call_id}`, "tool", e.data.tool_name, e.agent_id, i);
          attach(n, e, true);
        }
        close(n, i, e, e.data.ok, e.data.error ?? null, e.data.duration_ms);
        return;
      }
      case "approval.requested": {
        const n = node(`approval:${e.data.approval_id}`, "approval", e.data.reason, e.agent_id, i);
        attach(n, e, true);
        return;
      }
      case "approval.resolved": {
        const n = byId.get(`approval:${e.data.approval_id}`);
        if (!n) return;
        n.end = i;
        n.status = e.data.decision === "approved" ? "ok" : "none";
        n.error = e.data.decision === "approved" ? null : e.data.decision;
        n.durationMs = Date.parse(e.ts) - Date.parse(events[n.start]!.ts);
        return;
      }
      case "llm.call": {
        const n = node(`event:${e.id}`, "llm", e.model ?? "Model call", e.agent_id, i);
        n.status = "none";
        n.durationMs = e.data.duration_ms ?? null;
        attach(n, e, true);
        return;
      }
      case "handoff": {
        const n = node(`event:${e.id}`, "handoff", `Handoff ${e.data.from_agent_id} → ${e.data.to_agent_id}`, e.agent_id, i);
        n.status = "none";
        attach(n, e, true);
        return;
      }
      case "message": {
        const n = node(`event:${e.id}`, "message", e.summary ?? "Message", e.agent_id, i);
        n.status = "none";
        attach(n, e, true);
        return;
      }
      case "error": {
        const n = node(`event:${e.id}`, "error", e.data.message, e.agent_id, i);
        n.status = "error";
        n.error = e.data.message;
        attach(n, e, true);
        return;
      }
      case "run.control": {
        const verb = e.data.action === "pause" ? "Paused" : e.data.action === "resume" ? "Resumed" : "Cancelled";
        const n = node(`event:${e.id}`, "control", `${verb}${e.data.by ? ` by ${e.data.by}` : ""}`, e.agent_id, i);
        n.status = "none";
        attach(n, e, true);
        return;
      }
      default:
        return;
    }
  });

  // Anything still open runs to the end of what we have.
  for (const n of byId.values()) {
    if (n.status === "open" && n !== root) n.end = Math.max(n.end, last);
  }

  const flat: TraceNode[] = [];
  const walk = (n: TraceNode, depth: number): void => {
    n.depth = depth;
    flat.push(n);
    for (const c of n.children) walk(c, depth + 1);
    const own = n.kind === "llm" ? usageOf(events[n.start]!) : ZERO;
    n.usage = n.children.reduce((u, c) => add(u, c.usage), own);
    n.llmCalls = (n.kind === "llm" ? 1 : 0) + n.children.reduce((s, c) => s + c.llmCalls, 0);
    n.toolCalls = (n.kind === "tool" ? 1 : 0) + n.children.reduce((s, c) => s + c.toolCalls, 0);
    n.hasError = n.status === "error" || n.children.some((c) => c.hasError);
  };
  walk(root, 0);

  let firstError: TraceNode | null = null;
  for (const n of flat) {
    if (n.status !== "error" || n === root) continue;
    if (!firstError || n.end < firstError.end || (n.end === firstError.end && n.depth > firstError.depth)) firstError = n;
  }
  // Cast: TS narrows `root.status` to the "open" set above and misses the callback writes.
  if (!firstError && (root.status as TraceStatus) === "error") firstError = root;

  return { root, byId, flat, firstError };
}

/** The node an event belongs to: the most recently started one whose span covers `index`. */
export function nodeAt(trace: Trace, index: number): TraceNode | null {
  let best: TraceNode | null = null;
  for (const n of trace.flat) {
    if (n === trace.root || n.start > index || n.end < index) continue;
    if (!best || n.start > best.start || (n.start === best.start && n.depth > best.depth)) best = n;
  }
  return best;
}

/** Ids from the root down to `id` (inclusive). Empty if the node doesn't exist. */
export function pathTo(trace: Trace, id: string): string[] {
  const out: string[] = [];
  for (let n = trace.byId.get(id); n; n = n.parentId ? trace.byId.get(n.parentId) : undefined) out.unshift(n.id);
  return out;
}

function node(id: string, kind: TraceKind, label: string, agentId: string | null, i: number): TraceNode {
  return {
    id,
    kind,
    label,
    agentId,
    parentId: null,
    depth: 0,
    start: i,
    end: i,
    durationMs: null,
    status: kind === "step" || kind === "tool" || kind === "approval" ? "open" : "none",
    error: null,
    inferred: false,
    children: [],
    usage: ZERO,
    llmCalls: 0,
    toolCalls: 0,
    hasError: false,
  };
}

function add(a: Usage, b: Usage): Usage {
  return {
    tokens_in: a.tokens_in + b.tokens_in,
    tokens_out: a.tokens_out + b.tokens_out,
    cost_usd: a.cost_usd + b.cost_usd,
    cost_estimated_usd: a.cost_estimated_usd + b.cost_estimated_usd,
    unpriced_calls: a.unpriced_calls + b.unpriced_calls,
  };
}
