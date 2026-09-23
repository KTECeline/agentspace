"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, CircleGeometry, CylinderGeometry, Euler, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry } from "three";
import type { Desk } from "@/lib/layout";
import type { ScenePalette } from "./palette";

/**
 * All static furniture for every desk, drawn with one InstancedMesh per part. 50 desks would
 * otherwise cost ~450 draw calls; this is 9. Positions are in the desk's local frame (the avatar
 * sits at local -z, facing the desk at +z), matching Workstation.tsx.
 */
interface Part {
  key: string;
  geometry: BufferGeometry;
  color: keyof ScenePalette;
  offset: [number, number, number];
  rotation?: [number, number, number];
  opacity?: number;
  flat?: boolean;
}

const PARTS: Part[] = [
  { key: "top", geometry: new BoxGeometry(1.5, 0.07, 0.75), color: "wood", offset: [0, 0.74, 0.42], flat: true },
  { key: "legL", geometry: new BoxGeometry(0.07, 0.74, 0.6), color: "woodDark", offset: [-0.65, 0.37, 0.42], flat: true },
  { key: "legR", geometry: new BoxGeometry(0.07, 0.74, 0.6), color: "woodDark", offset: [0.65, 0.37, 0.42], flat: true },
  { key: "stand", geometry: new BoxGeometry(0.08, 0.14, 0.08), color: "monitor", offset: [0, 0.84, 0.62] },
  { key: "monitor", geometry: new BoxGeometry(0.66, 0.4, 0.05), color: "monitor", offset: [0, 1.06, 0.64] },
  { key: "keyboard", geometry: new BoxGeometry(0.5, 0.025, 0.16), color: "wallTrim", offset: [0, 0.785, 0.3] },
  { key: "lampPost", geometry: new CylinderGeometry(0.015, 0.015, 0.25, 5), color: "monitor", offset: [0.55, 0.9, 0.62] },
  { key: "seat", geometry: new BoxGeometry(0.55, 0.08, 0.5), color: "chair", offset: [0, 0.42, -0.32], flat: true },
  { key: "back", geometry: new BoxGeometry(0.55, 0.55, 0.08), color: "chair", offset: [0, 0.72, -0.56], flat: true },
  { key: "post", geometry: new CylinderGeometry(0.04, 0.04, 0.4, 6), color: "monitor", offset: [0, 0.2, -0.32] },
  {
    key: "shadow",
    geometry: new CircleGeometry(0.55, 20),
    color: "shadow",
    offset: [0, 0.056, -0.25],
    rotation: [-Math.PI / 2, 0, 0],
    opacity: 0.14,
  },
];

export function Furniture({ desks, palette }: { desks: Desk[]; palette: ScenePalette }) {
  return (
    <>
      {PARTS.map((part) => (
        <PartInstances key={part.key} part={part} desks={desks} color={palette[part.color]} />
      ))}
    </>
  );
}

function PartInstances({ part, desks, color }: { part: Part; desks: Desk[]; color: string }) {
  const ref = useRef<InstancedMesh>(null);
  const tmp = useMemo(
    () => ({ m: new Matrix4(), local: new Matrix4(), q: new Quaternion(), p: new Vector3(), s: new Vector3(1, 1, 1), e: new Euler() }),
    [],
  );

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const { m, local, q, p, s, e } = tmp;
    e.set(...(part.rotation ?? [0, 0, 0]));
    local.compose(new Vector3(...part.offset), new Quaternion().setFromEuler(e), s);
    desks.forEach((desk, i) => {
      q.setFromAxisAngle(new Vector3(0, 1, 0), desk.rotationY);
      p.set(desk.x, 0, desk.z);
      m.compose(p, q, s).multiply(local);
      mesh.setMatrixAt(i, m);
    });
    mesh.count = desks.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [desks, part, tmp]);

  // Capacity grows in steps so adding one agent doesn't reallocate every time.
  const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, desks.length))));
  return (
    <instancedMesh key={capacity} ref={ref} args={[part.geometry, undefined, capacity]} frustumCulled={false}>
      {part.opacity !== undefined ? (
        <meshBasicMaterial color={color} transparent opacity={part.opacity} depthWrite={false} />
      ) : (
        <meshStandardMaterial color={color} flatShading={part.flat} />
      )}
    </instancedMesh>
  );
}
