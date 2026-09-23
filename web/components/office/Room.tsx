"use client";

import { memo } from "react";
import { RoundedBox } from "@react-three/drei";
import type { Room as RoomT } from "@/lib/layout";
import { hashIndex, RUGS, RUGS_DARK, type ScenePalette } from "./palette";

interface Props {
  room: RoomT;
  palette: ScenePalette;
  dark: boolean;
}

/** A team's room: pastel rug, two low walls and plants. The name plate is in Labels.tsx. */
export const Room = memo(function Room({ room, palette, dark }: Props) {
  const rugs = dark ? RUGS_DARK : RUGS;
  const rug = rugs[hashIndex(room.teamId || "_none", rugs.length)]!;
  const { width: w, depth: d } = room;
  const wallH = 0.55;

  return (
    <group position={[room.x, 0, room.z]}>
      <RoundedBox args={[w - 0.4, 0.05, d - 0.4]} radius={0.02} smoothness={2} position={[0, 0.025, 0]}>
        <meshStandardMaterial color={rug} roughness={0.95} />
      </RoundedBox>
      {/* back and left walls (the camera looks from the front-right, so these never hide agents) */}
      <mesh position={[0, wallH / 2, -d / 2 + 0.08]}>
        <boxGeometry args={[w, wallH, 0.16]} />
        <meshStandardMaterial color={palette.wall} flatShading />
      </mesh>
      <mesh position={[0, wallH + 0.02, -d / 2 + 0.08]}>
        <boxGeometry args={[w, 0.04, 0.2]} />
        <meshStandardMaterial color={palette.wallTrim} />
      </mesh>
      <mesh position={[-w / 2 + 0.08, wallH / 2, 0]}>
        <boxGeometry args={[0.16, wallH, d]} />
        <meshStandardMaterial color={palette.wall} flatShading />
      </mesh>
      {/* back-left would sit behind the first agent's head in the isometric view, so use front-left */}
      <Plant position={[-w / 2 + 0.5, 0, d / 2 - 0.5]} palette={palette} />
      <Plant position={[w / 2 - 0.55, 0, -d / 2 + 0.55]} palette={palette} small />
    </group>
  );
});

function Plant({ position, palette, small = false }: { position: [number, number, number]; palette: ScenePalette; small?: boolean }) {
  const s = small ? 0.75 : 1;
  return (
    <group position={position} scale={s}>
      <mesh position={[0, 0.18, 0]}>
        <cylinderGeometry args={[0.16, 0.12, 0.36, 7]} />
        <meshStandardMaterial color={palette.plantPot} flatShading />
      </mesh>
      <mesh position={[0, 0.55, 0]}>
        <icosahedronGeometry args={[0.3, 0]} />
        <meshStandardMaterial color={palette.plant} flatShading />
      </mesh>
      <mesh position={[0.12, 0.78, 0.05]}>
        <icosahedronGeometry args={[0.18, 0]} />
        <meshStandardMaterial color={palette.plant} flatShading />
      </mesh>
    </group>
  );
}
