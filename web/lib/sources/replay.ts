import type { AgentSpaceEvent, AgentState, RunState, StoredEvent, WsServerMessage } from "@agentspace/spec-types";
import type { Projector } from "../projector";
import { approvalsFrom, countAt, snapshotAt, type Timeline } from "../replay";
import type { Connection } from "../store";
import type { Sink, Source } from "./types";

export interface ReplayStatus {
  /** Replay time, ms from the start. */
  position: number;
  duration: number;
  playing: boolean;
  speed: number;
  /** Events that have happened so far. */
  count: number;
}

export interface ReplayOptions {
  speed?: number;
  autoplay?: boolean;
  /** Start over after a short pause (the /demo recordings). */
  loop?: boolean;
  /** What the connection pill says. */
  connection?: Extract<Connection, "recording" | "replay">;
  /** Shown under the scrubber (for example, that a long run was cut). */
  note?: string;
  /** Open paused on this event (an index into the timeline), for links into a run. */
  startIndex?: number;
}

const TICK_MS = 50;
const LOOP_GAP_MS = 2500;
/** The scrubber doesn't need 20 updates a second. */
const NOTIFY_MS = 100;

/**
 * Plays a timeline into the office store like any other source, with play/pause, speed and
 * seek. Seeking re-projects from the start (cheap: runs are thousands of events, not millions)
 * and sends one snapshot, so the office jumps straight to that moment.
 */
export class ReplayPlayer {
  private status: ReplayStatus;
  private listeners = new Set<() => void>();
  private sink: Sink | null = null;
  private projector: Projector | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = 0;
  private lastNotify = 0;
  private pendingSeek: number | null = null;
  readonly note: string | null;
  readonly startIndex: number | null;

  constructor(
    readonly timeline: Timeline,
    private readonly workspace: string,
    private readonly opts: ReplayOptions = {},
  ) {
    this.status = { position: 0, duration: timeline.duration, playing: false, speed: opts.speed ?? 1, count: 0 };
    this.note = opts.note ?? null;
    this.startIndex = opts.startIndex !== undefined && timeline.times[opts.startIndex] !== undefined ? opts.startIndex : null;
  }

  readonly source: Source = (sink) => {
    this.sink = sink;
    sink.setConnection(this.opts.connection ?? "replay");
    if (this.startIndex !== null) {
      this.jump(this.timeline.times[this.startIndex]!);
      return () => {
        this.stopTimers();
        this.sink = null;
      };
    }
    this.jump(0);
    if (this.opts.autoplay ?? true) this.play();
    return () => {
      this.stopTimers();
      this.sink = null;
    };
  };

  // --- for useSyncExternalStore ---
  getStatus = (): ReplayStatus => this.status;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  play(): void {
    if (this.status.playing) return;
    if (this.status.position >= this.timeline.duration) this.jump(0);
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.update({ playing: true }, true);
  }

  pause(): void {
    this.stopTimers();
    this.update({ playing: false }, true);
  }

  toggle(): void {
    if (this.status.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number): void {
    this.update({ speed }, true);
  }

  /** Jump to replay time `ms`. Coalesced to one re-projection per ~frame while dragging. */
  seek(ms: number): void {
    const first = this.pendingSeek === null;
    this.pendingSeek = ms;
    if (!first) return;
    const run = () => {
      const target = this.pendingSeek;
      this.pendingSeek = null;
      if (target !== null) this.jump(target);
    };
    // A timer, not requestAnimationFrame: rAF doesn't run in background tabs, which would leave
    // this seek pending forever and swallow every later one.
    setTimeout(run, 16);
  }

  /** `keepAgents`: a loop restart leaves everyone at their desks instead of emptying the office. */
  private jump(ms: number, keepAgents = false): void {
    const position = Math.min(Math.max(0, ms), this.timeline.duration);
    const count = countAt(this.timeline, position);
    const previous = keepAgents && this.projector ? new Map(this.projector.agentList(this.workspace).map((a) => [a.agent_id, a])) : null;
    const { message, projector } = snapshotAt(this.timeline, count, this.workspace);
    this.projector = projector;
    if (previous && message.type === "snapshot") {
      const now = new Map(message.agents.map((a) => [a.agent_id, a]));
      message.agents = this.timeline.agentOrder.flatMap((id) => {
        const a = now.get(id) ?? previous.get(id);
        return a ? [a] : [];
      });
    }
    this.sink?.send(message);
    this.lastTick = Date.now();
    this.update({ position, count }, true);
  }

  private tick(): void {
    const now = Date.now();
    const position = Math.min(this.timeline.duration, this.status.position + (now - this.lastTick) * this.status.speed);
    this.lastTick = now;
    const count = countAt(this.timeline, position);
    if (count > this.status.count) this.emit(this.status.count, count);
    const ended = position >= this.timeline.duration;
    this.update({ position, count, ...(ended ? { playing: false } : {}) }, ended);
    if (!ended) return;
    this.stopTimers();
    if (this.opts.loop) {
      this.loopTimer = setTimeout(() => {
        this.jump(0, true);
        this.play();
      }, LOOP_GAP_MS);
    }
  }

  /** Send events [from, to) as the collector would: events plus the rows they changed. */
  private emit(from: number, to: number): void {
    if (!this.sink || !this.projector) return;
    const stored: StoredEvent[] = [];
    const agents = new Map<string, AgentState>();
    const runs = new Map<string, RunState>();
    let approvals = false;
    for (let i = from; i < to; i++) {
      const ev = { ...this.timeline.events[i]!, workspace: this.workspace } as AgentSpaceEvent;
      const { agent, run } = this.projector.apply(ev);
      stored.push({ ...ev, seq: i + 1 });
      if (agent) agents.set(agent.agent_id, agent);
      runs.set(run.run_id, run);
      if (ev.type === "approval.requested" || ev.type === "approval.resolved") approvals = true;
    }
    const out: WsServerMessage[] = [{ type: "events", events: stored }];
    if (agents.size) out.push({ type: "agents", agents: [...agents.values()] });
    out.push({ type: "runs", runs: [...runs.values()] });
    if (approvals) {
      const upto = this.timeline.events.slice(0, to).map((e) => ({ ...e, workspace: this.workspace }) as AgentSpaceEvent);
      out.push({ type: "approvals", approvals: approvalsFrom(upto) });
    }
    out.forEach((m) => this.sink?.send(m));
  }

  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.timer = null;
    this.loopTimer = null;
  }

  private update(patch: Partial<ReplayStatus>, force: boolean): void {
    this.status = { ...this.status, ...patch };
    const now = Date.now();
    if (!force && now - this.lastNotify < NOTIFY_MS) return;
    this.lastNotify = now;
    this.listeners.forEach((fn) => fn());
  }
}
