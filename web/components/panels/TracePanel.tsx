"use client";

import { useMemo, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Crosshair,
  Hand,
  Layers,
  MessageSquare,
  Play,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { clock, formatDuration, formatTokens } from "@/lib/format";
import type { ReplayPlayer } from "@/lib/sources/replay";
import { buildTrace, nodeAt, pathTo, type Trace, type TraceKind, type TraceNode } from "@/lib/trace";
import { Cost } from "../Cost";

const ICON: Record<TraceKind, typeof Wrench> = {
  run: Play,
  step: Layers,
  tool: Wrench,
  llm: Sparkles,
  handoff: ArrowRightLeft,
  approval: Hand,
  message: MessageSquare,
  error: CircleAlert,
  control: CirclePause,
};

const KIND_LABEL: Record<TraceKind, string> = {
  run: "Run",
  step: "Step",
  tool: "Tool call",
  llm: "Model call",
  handoff: "Handoff",
  approval: "Approval",
  message: "Message",
  error: "Error",
  control: "Run control",
};

/** Status dot tone (data-status): failed, still running, finished fine, or nothing to judge. */
function tone(n: TraceNode): string | undefined {
  if (n.status === "error") return "error";
  if (n.status === "open") return "thinking";
  if (n.kind === "approval") return "waiting_human";
  if (n.status === "ok") return "done";
  return undefined;
}

interface Props {
  player: ReplayPlayer;
  names: Record<string, string>;
}

/**
 * The run inspector (D-043): the replay's events as a tree, tied to the scrubber both ways.
 * Selecting a node pauses and seeks to it; while playing, the node under the scrubber is
 * highlighted and its ancestors open.
 */
export function TracePanel({ player, names: known }: Props) {
  const tl = player.timeline;
  const trace = useMemo(() => buildTrace(tl.events), [tl]);
  // From the whole run, so agents that haven't appeared yet at this point of the replay have names.
  const names = useMemo(() => {
    const out: Record<string, string> = { ...known };
    for (const e of tl.events) if (e.type === "agent.registered" && e.agent_id) out[e.agent_id] = e.data.name;
    return out;
  }, [tl, known]);
  const { count } = useSyncExternalStore(player.subscribe, player.getStatus, player.getStatus);
  const active = count > 0 ? nodeAt(trace, count - 1) : null;
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string>(trace.root.id);
  // User choices override the default (open: the root, and the path to the active or selected node).
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());

  const auto = useMemo(() => new Set([...(active ? pathTo(trace, active.id) : []), ...(selected ? pathTo(trace, selected) : [])]), [trace, active, selected]);
  const isOpen = (n: TraceNode) => toggled.get(n.id) ?? (n.depth === 0 || auto.has(n.id));
  const rows = visibleRows(trace, isOpen);
  const errorPath = useMemo(() => new Set(trace.firstError ? pathTo(trace, trace.firstError.id) : []), [trace]);

  const setOpen = (id: string, open: boolean) => setToggled((m) => new Map(m).set(id, open));
  const choose = (n: TraceNode) => {
    setSelected(n.id);
    setFocused(n.id);
    // Show the opened path even if the user had collapsed part of it.
    setToggled((m) => {
      const next = new Map(m);
      for (const id of pathTo(trace, n.id).slice(0, -1)) next.set(id, true);
      return next;
    });
    player.pause();
    player.seek(tl.times[n.start] ?? 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const at = rows.findIndex((r) => r.id === focused);
    const cur = rows[at];
    if (!cur) return;
    const move = (to: TraceNode | undefined) => {
      if (!to) return;
      setFocused(to.id);
      document.getElementById(rowId(to.id))?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        move(rows[at + 1]);
        break;
      case "ArrowUp":
        move(rows[at - 1]);
        break;
      case "Home":
        move(rows[0]);
        break;
      case "End":
        move(rows.at(-1));
        break;
      case "ArrowRight":
        if (cur.children.length && !isOpen(cur)) setOpen(cur.id, true);
        else move(cur.children[0]);
        break;
      case "ArrowLeft":
        if (cur.children.length && isOpen(cur)) setOpen(cur.id, false);
        else move(cur.parentId ? trace.byId.get(cur.parentId) : undefined);
        break;
      case "Enter":
      case " ":
        choose(cur);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const selectedNode = selected ? trace.byId.get(selected) : undefined;

  return (
    <section aria-labelledby="trace-title" className="flex max-h-[70vh] min-h-0 flex-1 flex-col rounded-xl border border-border bg-surface lg:max-h-none">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <h2 id="trace-title" className="mr-auto font-semibold">
          Trace
        </h2>
        <span className="text-xs text-muted">
          {trace.root.toolCalls} tool {trace.root.toolCalls === 1 ? "call" : "calls"} · {trace.root.llmCalls} model {trace.root.llmCalls === 1 ? "call" : "calls"}
        </span>
        <button
          type="button"
          disabled={!trace.firstError}
          onClick={() => trace.firstError && choose(trace.firstError)}
          data-status={trace.firstError ? "error" : undefined}
          title={trace.firstError ? "Jump to the earliest thing that failed" : "Nothing failed in this run"}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Crosshair aria-hidden className={`size-4 ${trace.firstError ? "text-[var(--st-fg)]" : ""}`} />
          First error
        </button>
      </header>

      {trace.flat.length === 1 ? (
        <p className="p-6 text-center text-sm text-muted">This run has no steps, tool calls or model calls to show.</p>
      ) : (
        <ul role="tree" aria-label="Run trace" onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto py-1 text-sm">
          {rows.map((n) => (
            <TraceRow
              key={n.id}
              node={n}
              label={displayLabel(n, tl.events, names)}
              agent={agentLabel(trace, n, names)}
              open={isOpen(n)}
              active={active?.id === n.id}
              selected={selected === n.id}
              onErrorPath={selected === trace.firstError?.id && errorPath.has(n.id)}
              focusable={focused === n.id}
              onToggle={() => setOpen(n.id, !isOpen(n))}
              onChoose={() => choose(n)}
              onFocus={() => setFocused(n.id)}
            />
          ))}
        </ul>
      )}

      {selectedNode && (
        <NodeDetail node={selectedNode} events={tl.events} names={names} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}

function visibleRows(trace: Trace, isOpen: (n: TraceNode) => boolean): TraceNode[] {
  const out: TraceNode[] = [];
  const walk = (n: TraceNode) => {
    out.push(n);
    if (isOpen(n)) n.children.forEach(walk);
  };
  walk(trace.root);
  return out;
}

/** Handoffs are stored with agent ids; show names. */
function displayLabel(n: TraceNode, events: AgentSpaceEvent[], names: Record<string, string>): string {
  const e = events[n.start];
  if (n.kind !== "handoff" || e?.type !== "handoff") return n.label;
  return `Handoff ${names[e.data.from_agent_id] ?? e.data.from_agent_id} → ${names[e.data.to_agent_id] ?? e.data.to_agent_id}`;
}

/** The agent's name, only where it changes from the parent's (and isn't already the label). */
function agentLabel(trace: Trace, n: TraceNode, names: Record<string, string>): string | null {
  // A handoff's label already names both agents.
  if (!n.agentId || n.kind === "handoff") return null;
  const parent = n.parentId ? trace.byId.get(n.parentId) : undefined;
  if (parent?.agentId === n.agentId) return null;
  const name = names[n.agentId] ?? n.agentId;
  return name === n.label ? null : name;
}

const rowId = (id: string) => `trace-${id.replace(/[^\w-]/g, "_")}`;

interface RowProps {
  node: TraceNode;
  label: string;
  agent: string | null;
  open: boolean;
  active: boolean;
  selected: boolean;
  onErrorPath: boolean;
  focusable: boolean;
  onToggle: () => void;
  onChoose: () => void;
  onFocus: () => void;
}

function TraceRow({ node: n, label, agent, open, active, selected, onErrorPath, focusable, onToggle, onChoose, onFocus }: RowProps) {
  const Icon = ICON[n.kind];
  const t = tone(n);
  return (
    <li
      id={rowId(n.id)}
      role="treeitem"
      aria-level={n.depth + 1}
      aria-expanded={n.children.length ? open : undefined}
      aria-selected={selected}
      aria-current={active ? "step" : undefined}
      tabIndex={focusable ? 0 : -1}
      onFocus={onFocus}
      onClick={onChoose}
      data-status={onErrorPath ? "error" : undefined}
      className={`group flex min-h-9 cursor-pointer items-center gap-1.5 border-l-2 pr-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
        selected ? "border-accent bg-surface-2" : active ? "border-[var(--st-thinking-dot)] bg-surface-2/60" : "border-transparent hover:bg-surface-2/60"
      } ${onErrorPath ? "bg-[var(--st-bg)]" : ""}`}
      style={{ paddingLeft: `${0.5 + n.depth * 1}rem` }}
    >
      {n.children.length ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-surface-2"
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ) : (
        <span aria-hidden className="size-6 shrink-0" />
      )}
      <span data-status={t} className="relative shrink-0">
        <Icon aria-hidden className={`size-4 ${t ? "text-[var(--st-fg)]" : "text-muted"}`} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="sr-only">{KIND_LABEL[n.kind]}: </span>
        {label}
        {agent && <span className="ml-1.5 text-xs text-muted">{agent}</span>}
      </span>
      {n.inferred && (
        <span title="This event had no parent; it's placed by time under the agent's open step or tool." className="shrink-0 text-xs text-muted">
          ~<span className="sr-only">placed by time</span>
        </span>
      )}
      {n.hasError && n.status !== "error" && (
        <span data-status="error" className="shrink-0" title="Something under this failed">
          <span aria-hidden className="block size-1.5 rounded-full bg-[var(--st-dot)]" />
          <span className="sr-only">contains a failure</span>
        </span>
      )}
      {n.status === "error" && <span className="sr-only">failed</span>}
      {n.status === "open" && <span className="sr-only">not finished</span>}
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted">{n.durationMs != null ? formatDuration(n.durationMs) : n.status === "open" ? "…" : ""}</span>
    </li>
  );
}

function NodeDetail({ node: n, events, names, onClose }: { node: TraceNode; events: AgentSpaceEvent[]; names: Record<string, string>; onClose: () => void }) {
  const first = events[n.start];
  const last = events[n.end];
  const content = contentOf(n, events);
  const decision = n.kind === "approval" && last?.type === "approval.resolved" ? last.data.decision : null;
  return (
    <section aria-labelledby="trace-detail-title" className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border p-3 text-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">{KIND_LABEL[n.kind]}</p>
          <h3 id="trace-detail-title" className="break-words font-semibold">
            {displayLabel(n, events, names)}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      {n.error && (
        <p data-status={n.status === "error" ? "error" : "waiting"} className="mt-2 break-words rounded-md bg-[var(--st-bg)] px-2 py-1.5 text-[var(--st-fg)]">
          {n.status === "error" ? n.error : `Decision: ${n.error}`}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {n.agentId && <Field label="Agent">{names[n.agentId] ?? n.agentId}</Field>}
        <Field label="Status">{n.status === "open" ? "Not finished" : n.status === "error" ? "Failed" : decision ? decision : n.status === "ok" ? "OK" : "—"}</Field>
        {first && <Field label="Started">{clock(first.ts)}</Field>}
        {n.durationMs != null && <Field label="Duration">{formatDuration(n.durationMs)}</Field>}
        {n.kind === "llm" && first?.model && <Field label="Model">{first.model}</Field>}
        {n.kind === "llm" && first?.type === "llm.call" && first.data.finish_reason && <Field label="Finish">{first.data.finish_reason}</Field>}
        {(n.usage.tokens_in > 0 || n.usage.tokens_out > 0) && (
          <Field label="Tokens">
            {formatTokens(n.usage.tokens_in)} in · {formatTokens(n.usage.tokens_out)} out
          </Field>
        )}
        {(n.usage.cost_usd > 0 || n.usage.unpriced_calls > 0) && (
          <Field label="Cost">
            <Cost totals={n.usage} />
          </Field>
        )}
        {n.children.length > 0 && (
          <Field label="Inside">
            {n.toolCalls} tool, {n.llmCalls} model {n.llmCalls === 1 ? "call" : "calls"}
          </Field>
        )}
        {first?.summary && n.kind !== "message" && <Field label="Summary">{first.summary}</Field>}
      </dl>

      {n.inferred && <p className="mt-2 text-xs text-muted">This event had no parent, so it&apos;s placed by time under the agent&apos;s open step or tool.</p>}

      {content.length > 0 ? (
        content.map(([label, value]) => (
          <div key={label} className="mt-3">
            <h4 className="text-xs font-medium text-muted">{label}</h4>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 font-mono text-xs">{show(value)}</pre>
          </div>
        ))
      ) : (n.kind === "llm" || n.kind === "tool") ? (
        <p className="mt-3 text-xs text-muted">
          Inputs and outputs weren&apos;t captured. Start the SDK with <code className="font-mono">capture_content=True</code> to record them (after redaction).
        </p>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-xs leading-5 tabular-nums">{children}</dd>
    </>
  );
}

/** Captured content on the node's events (only present with capture_content=True). */
function contentOf(n: TraceNode, events: AgentSpaceEvent[]): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const i of new Set([n.start, n.end])) {
    const e = events[i];
    if (!e) continue;
    if (e.type === "llm.call") {
      if (e.data.input !== undefined) out.push(["Input", e.data.input]);
      if (e.data.output !== undefined) out.push(["Output", e.data.output]);
    } else if (e.type === "tool.call" && e.data.arguments !== undefined) out.push(["Arguments", e.data.arguments]);
    else if (e.type === "tool.result" && e.data.result !== undefined) out.push(["Result", e.data.result]);
    else if (e.type === "approval.requested" && e.data.payload !== undefined && e.data.payload !== null) out.push(["Payload", e.data.payload]);
    else if (e.type === "message" && e.data.text !== undefined) out.push(["Text", e.data.text]);
    else if (e.type === "error" && e.data.stack) out.push(["Stack", e.data.stack]);
  }
  return out;
}

const MAX_SHOWN = 20_000;
function show(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}\n… (${s.length - MAX_SHOWN} more characters)` : s;
}
