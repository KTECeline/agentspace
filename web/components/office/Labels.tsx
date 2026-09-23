"use client";

import { memo, useCallback, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { OfficeLayout } from "@/lib/layout";
import { teamLabel } from "@/lib/format";
import { useOffice } from "@/lib/store";
import { bubbleText } from "./statusStyle";

/**
 * Screen-space labels (room names, speech bubbles, name tags) drawn as ONE plain DOM layer
 * over the canvas, in the app's own React tree.
 *
 * Why not drei <Html>: each <Html> creates its own React root. Under React 19 StrictMode those
 * roots get unmounted mid-render and rarely-updated labels stay blank, and 50+ roots is slow.
 * Here, one useFrame projects every anchor and writes `transform` directly (no React renders).
 */
export interface Anchor {
  pos: Vector3;
  el: HTMLElement | null;
  /** Last transform written, so an idle camera costs no style writes. */
  last?: string;
}
export type AnchorMap = Map<string, Anchor>;

/** Inside <Canvas>: projects each anchor to screen space every frame. */
export function LabelProjector({ anchors }: { anchors: AnchorMap }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useRef(new Vector3());
  useFrame(() => {
    for (const a of anchors.values()) {
      if (!a.el) continue;
      v.current.copy(a.pos).project(camera);
      const x = ((v.current.x + 1) / 2) * size.width;
      const y = ((1 - v.current.y) / 2) * size.height;
      const off = x < -200 || y < -200 || x > size.width + 200 || y > size.height + 200;
      const next = off ? "off" : `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      if (next === a.last) continue;
      a.last = next;
      a.el.style.visibility = off ? "hidden" : "visible";
      if (!off) a.el.style.transform = next;
    }
  });
  return null;
}

/** Outside <Canvas>: the DOM layer holding every label. */
export function LabelLayer({ layout, anchors, showNames, teamCounts }: { layout: OfficeLayout; anchors: AnchorMap; showNames: boolean; teamCounts: Record<string, number> }) {
  const register = useCallback(
    (id: string, pos: [number, number, number]) => (el: HTMLElement | null) => {
      if (el) anchors.set(id, { pos: new Vector3(...pos), el });
      else anchors.delete(id);
    },
    [anchors],
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {layout.rooms.map((room) => (
        <div key={room.key} ref={register(`room:${room.key}`, [room.x, 1.05, room.z - room.depth / 2 + 0.1])} className="absolute left-0 top-0 will-change-transform">
          <div className="whitespace-nowrap rounded-full border border-border bg-surface/90 px-3 py-1 font-display text-sm font-semibold text-foreground shadow-sm">
            {teamLabel(room.teamId) + (room.part ? ` ${room.part + 1}` : "")}{" "}
            <span className="font-sans text-xs font-normal text-muted">· {teamCounts[room.key] ?? 0}</span>
          </div>
        </div>
      ))}
      {Object.values(layout.desks).map((desk) => {
        // The avatar's head, in world space (the avatar sits 0.3 behind the desk centre).
        const bx = desk.x - Math.sin(desk.rotationY) * 0.3;
        const bz = desk.z - Math.cos(desk.rotationY) * 0.3;
        return (
          <div key={desk.agentId} ref={register(`agent:${desk.agentId}`, [bx, 1.7, bz])} className="absolute left-0 top-0 will-change-transform">
            <AgentTag agentId={desk.agentId} showName={showNames} />
          </div>
        );
      })}
    </div>
  );
}

const AgentTag = memo(function AgentTag({ agentId, showName }: { agentId: string; showName: boolean }) {
  const agent = useOffice((s) => s.agents[agentId]);
  const emphasized = useOffice((s) => s.selectedAgent === agentId || s.hoveredAgent === agentId);
  if (!agent) return null;
  const bubble = bubbleText(agent.status, agent.status_detail);
  return (
    <div className="flex flex-col items-center gap-1 pb-1">
      {bubble && (
        <div
          data-status={agent.status}
          className="max-w-40 truncate rounded-2xl border border-border/60 bg-surface px-2.5 py-0.5 font-display text-sm font-medium text-[var(--st-fg)] shadow-md"
        >
          {bubble}
        </div>
      )}
      {(showName || emphasized) && (
        <div className={`whitespace-nowrap rounded-md px-1.5 py-px text-[11px] font-medium ${emphasized ? "bg-accent text-accent-foreground" : "bg-foreground/80 text-background"}`}>
          {agent.name}
        </div>
      )}
    </div>
  );
});
