import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { ProjectedEmitter } from "./projectedEmitter";
import type { Source } from "./types";

export interface Recording {
  format: "agentspace-recording";
  version: 1;
  name: string;
  run_id: string;
  events: AgentSpaceEvent[];
}

export interface PlaybackOptions {
  speed?: number;
  loop?: boolean;
  /** Pause between loops, ms. */
  gapMs?: number;
  /** Longest real-time wait between two events, ms (squashes idle gaps). */
  maxGapMs?: number;
}

/** Shift every timestamp so the recording looks like it is happening now. */
export function schedule(events: AgentSpaceEvent[], speed: number, maxGapMs: number): { at: number; event: AgentSpaceEvent }[] {
  const out: { at: number; event: AgentSpaceEvent }[] = [];
  let at = 0;
  let prev = events[0] ? Date.parse(events[0].ts) : 0;
  for (const event of events) {
    const t = Date.parse(event.ts);
    at += Math.min(Math.max(0, t - prev), maxGapMs) / speed;
    prev = t;
    out.push({ at, event });
  }
  return out;
}

/** Plays a recording through the same message stream as the live collector. No network. */
export function recordedSource(recording: Recording, workspace = "demo", opts: PlaybackOptions = {}): Source {
  const { speed = 1, loop = true, gapMs = 2500, maxGapMs = 4000 } = opts;
  const timeline = schedule(recording.events, speed, maxGapMs);

  return (sink) => {
    const emitter = new ProjectedEmitter(workspace);
    let timers: ReturnType<typeof setTimeout>[] = [];
    let iteration = 0;
    sink.setConnection("recording");

    const play = () => {
      iteration += 1;
      const suffix = iteration === 1 ? "" : `-${iteration}`;
      const start = Date.now();
      // Start from an empty office once; later loops keep everyone at their desks (no blink).
      if (iteration === 1) sink.send(emitter.snapshot());
      // Group events that fire at the same moment into one batch.
      const groups = new Map<number, AgentSpaceEvent[]>();
      for (const { at, event } of timeline) {
        const key = Math.round(at);
        const restamped = {
          ...event,
          id: event.id + suffix,
          run_id: event.run_id + suffix,
          ts: new Date(start + at).toISOString(),
        } as AgentSpaceEvent;
        groups.set(key, [...(groups.get(key) ?? []), restamped]);
      }
      for (const [at, events] of groups) {
        timers.push(setTimeout(() => emitter.emit(events).forEach(sink.send), at));
      }
      const end = timeline.at(-1)?.at ?? 0;
      if (loop) timers.push(setTimeout(play, end + gapMs));
    };

    play();
    return () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
  };
}
