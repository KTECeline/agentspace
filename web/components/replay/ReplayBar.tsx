"use client";

import { useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { findMarker, type Marker, type MarkerKind } from "@/lib/replay";
import type { ReplayPlayer } from "@/lib/sources/replay";

const SPEEDS = [1, 4, 16] as const;

/** Marker colors reuse the status tokens (data-status), each with a legend entry and a label. */
const KINDS: Record<MarkerKind, { status: string; label: string }> = {
  error: { status: "error", label: "Errors" },
  handoff: { status: "thinking", label: "Handoffs" },
  approval: { status: "waiting_human", label: "Approvals" },
  control: { status: "waiting", label: "Pause / cancel" },
};

const buttonClass =
  "inline-flex h-9 items-center justify-center gap-1 rounded-md border border-border bg-surface px-2.5 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-surface";

/** Play/pause, speed, a scrubber with the run's key moments, and jumps between them. */
export function ReplayBar({ player, showClock }: { player: ReplayPlayer; showClock: boolean }) {
  const status = useSyncExternalStore(player.subscribe, player.getStatus, player.getStatus);
  const tl = player.timeline;
  const { position, duration, playing, speed, count } = status;
  const current = count > 0 ? tl.events[count - 1] : undefined;
  const counts = tl.markers.reduce<Partial<Record<MarkerKind, number>>>((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] ?? 0) + 1 }), {});
  const jump = (m: Marker | undefined) => m && player.seek(m.at);
  const pct = (ms: number) => (duration ? (ms / duration) * 100 : 0);

  return (
    <section aria-label="Replay controls" className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => player.toggle()} aria-label={playing ? "Pause" : "Play"} className={`${buttonClass} w-9 px-0`}>
          {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
        </button>
        <span className="min-w-[5.5rem] font-mono text-xs tabular-nums text-muted" aria-live="off">
          {clock(position)} / {clock(duration)}
        </span>

        <div className="relative mx-1 min-w-[12rem] flex-1">
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(duration))}
            step={50}
            value={Math.round(position)}
            onChange={(e) => player.seek(Number(e.target.value))}
            aria-label="Replay position"
            aria-valuetext={`${clock(position)} of ${clock(duration)}${current ? `, ${current.summary ?? current.type}` : ""}`}
            className="relative z-10 h-9 w-full cursor-pointer accent-[var(--accent)]"
          />
          {/* Key moments, under the thumb. Each is also a button to jump there. */}
          <div className="pointer-events-none absolute inset-x-[7px] top-1/2 z-20 h-0">
            {tl.markers.map((m) => (
              <button
                key={m.index}
                type="button"
                tabIndex={-1}
                onClick={() => player.seek(m.at)}
                title={m.label}
                aria-label={`Jump to ${m.label}`}
                data-status={KINDS[m.kind].status}
                className="pointer-events-auto absolute -top-[11px] h-[22px] w-2 -translate-x-1/2 rounded-sm focus-visible:outline-none"
                style={{ left: `${pct(m.at)}%` }}
              >
                <span aria-hidden className="absolute inset-x-[2px] top-[2px] bottom-[2px] rounded-sm bg-[var(--st-dot)] ring-2 ring-[var(--surface)]" />
              </button>
            ))}
          </div>
        </div>

        <div role="group" aria-label="Speed" className="inline-flex rounded-md border border-border p-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => player.setSpeed(s)}
              className={`h-8 min-w-9 rounded px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                speed === s ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        <div role="group" aria-label="Jump" className="flex flex-wrap gap-1">
          <button type="button" className={buttonClass} onClick={() => jump(findMarker(tl, position, null, -1))} disabled={!tl.markers.length} aria-label="Previous key moment">
            <ChevronLeft aria-hidden className="size-4" />
          </button>
          <button type="button" className={buttonClass} onClick={() => jump(findMarker(tl, position, null, 1))} disabled={!tl.markers.length} aria-label="Next key moment">
            <ChevronRight aria-hidden className="size-4" />
          </button>
          <button type="button" className={buttonClass} onClick={() => jump(findMarker(tl, position, "error", 1))} disabled={!counts.error}>
            Next error
          </button>
          <button type="button" className={buttonClass} onClick={() => jump(findMarker(tl, position, "handoff", 1))} disabled={!counts.handoff}>
            Next handoff
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {(Object.keys(KINDS) as MarkerKind[])
          .filter((k) => counts[k])
          .map((k) => (
            <span key={k} data-status={KINDS[k].status} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-3 w-1.5 rounded-sm bg-[var(--st-dot)]" />
              {KINDS[k].label} ({counts[k]})
            </span>
          ))}
        {showClock && current && <span className="ml-auto font-mono tabular-nums">{new Date(current.ts).toLocaleString()}</span>}
        {player.note && <span className="w-full">{player.note}</span>}
        {duration > 0 && tl.times.length > 1 && (
          <span className="sr-only">Pauses longer than 3 seconds are shortened in the replay.</span>
        )}
      </div>
    </section>
  );
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
