"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { Desk } from "@/lib/layout";
import { useOffice } from "@/lib/store";

const POOL = 24;
const TRAIL = 3;

interface Flight {
  from: [number, number, number];
  to: [number, number, number];
  start: number;
  duration: number;
  height: number;
}

/** Position along a parabolic arc at progress u in [0, 1] (ease-in-out). */
export function arcPoint(f: Flight, u: number): [number, number, number] {
  const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
  return [
    f.from[0] + (f.to[0] - f.from[0]) * e,
    f.from[1] + (f.to[1] - f.from[1]) * e + Math.sin(Math.PI * e) * f.height,
    f.from[2] + (f.to[2] - f.from[2]) * e,
  ];
}

/**
 * Handoff packets: a glowing parcel flies in an arc from one desk to the other.
 * Uses a fixed pool of meshes, so a burst of handoffs never allocates.
 */
export function Packets({ desks, color, reducedMotion }: { desks: Record<string, Desk>; color: string; reducedMotion: boolean }) {
  const flights = useRef<(Flight | null)[]>(Array(POOL).fill(null));
  const groups = useRef<(Group | null)[]>([]);
  const lastSeq = useRef(0);
  const clockRef = useRef(0);
  const desksRef = useRef(desks);
  useEffect(() => {
    desksRef.current = desks;
  }, [desks]);

  useEffect(
    () =>
      useOffice.subscribe((s, prev) => {
        if (s.handoffs === prev.handoffs) return;
        const newest = s.handoffs.at(-1)?.seq ?? 0;
        if (newest < lastSeq.current) lastSeq.current = 0; // source was reset
        for (const h of s.handoffs) {
          if (h.seq <= lastSeq.current || h.type !== "handoff") continue;
          lastSeq.current = h.seq;
          if (reducedMotion) continue;
          const a = desksRef.current[h.data.from_agent_id];
          const b = desksRef.current[h.data.to_agent_id];
          if (!a || !b || a === b) continue;
          const slot = flights.current.findIndex((f) => f === null);
          if (slot < 0) continue; // pool full: skip rather than stutter
          const dist = Math.hypot(b.x - a.x, b.z - a.z);
          flights.current[slot] = {
            from: [a.x, 1.5, a.z],
            to: [b.x, 1.5, b.z],
            start: clockRef.current,
            duration: 0.9 + Math.min(dist, 30) * 0.03,
            height: 1.2 + Math.min(dist, 30) * 0.12,
          };
        }
      }),
    [reducedMotion],
  );

  useFrame(({ clock }) => {
    clockRef.current = clock.elapsedTime;
    flights.current.forEach((f, i) => {
      const g = groups.current[i];
      if (!g) return;
      if (!f) {
        g.visible = false;
        return;
      }
      const u = (clock.elapsedTime - f.start) / f.duration;
      if (u >= 1) {
        flights.current[i] = null;
        g.visible = false;
        return;
      }
      g.visible = true;
      g.children.forEach((child, k) => {
        const [x, y, z] = arcPoint(f, Math.max(0, u - k * 0.04));
        child.position.set(x, y, z);
        child.rotation.set(u * 6, u * 8, 0);
      });
    });
  });

  return (
    <>
      {Array.from({ length: POOL }, (_, i) => (
        <group key={i} ref={(g) => void (groups.current[i] = g)} visible={false}>
          {Array.from({ length: TRAIL + 1 }, (_, k) => (
            <mesh key={k} scale={k === 0 ? 1 : 0.7 - k * 0.15}>
              <octahedronGeometry args={[0.16, 0]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={k === 0 ? 1.2 : 0.6} transparent opacity={k === 0 ? 1 : 0.55} flatShading />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}
