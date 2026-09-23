"use client";

import { memo, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useCursor } from "@react-three/drei";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import type { Desk } from "@/lib/layout";
import { useOffice } from "@/lib/store";
import { hashIndex, STATUS_HEX } from "./palette";
import { STATUS_STYLE, pose } from "./statusStyle";

interface Props {
  desk: Desk;
  reducedMotion: boolean;
  bodyColor: string;
}

/**
 * One agent's workstation: desk, monitor, chair and the bean avatar sitting at it.
 * Re-renders only when *this* agent's row changes; animation runs in useFrame via refs.
 */
export const Workstation = memo(function Workstation({ desk, reducedMotion, bodyColor }: Props) {
  const agent = useOffice((s) => s.agents[desk.agentId]);
  const selected = useOffice((s) => s.selectedAgent === desk.agentId);
  const select = useOffice((s) => s.select);
  const hovered = useOffice((s) => s.hoveredAgent === desk.agentId);
  const hover = useOffice((s) => s.hover);
  useCursor(hovered);

  const body = useRef<Group>(null);
  const armL = useRef<Mesh>(null);
  const armR = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const screenMat = useRef<MeshStandardMaterial>(null);

  const phase = useMemo(() => hashIndex(desk.agentId, 1000) / 159, [desk.agentId]);
  const status = agent?.status ?? "idle";
  const style = STATUS_STYLE[status];
  const statusColor = STATUS_HEX[status];

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (body.current) {
      const p = reducedMotion ? { y: 0, tilt: 0, arms: 0, x: 0 } : pose(style.motion, t, phase);
      body.current.position.set(p.x, p.y, 0);
      body.current.rotation.x = p.tilt;
      if (armL.current) armL.current.rotation.x = -1.1 + p.arms;
      if (armR.current) armR.current.rotation.x = -1.1 - p.arms;
    }
    if (halo.current) {
      const pulse = reducedMotion ? 0.5 : 0.5 + Math.sin(t * 3) * 0.25;
      halo.current.scale.setScalar(1 + pulse * 0.25);
      (halo.current.material as MeshStandardMaterial).opacity = 0.18 + pulse * 0.2;
    }
    if (ring.current && !reducedMotion) ring.current.rotation.z = t * 0.6;
    if (screenMat.current && style.screenOn && !reducedMotion && status === "using_tool") {
      screenMat.current.emissiveIntensity = 0.9 + Math.sin(t * 17 + phase) * 0.25;
    }
  });

  const onSelect = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    select(selected ? null : desk.agentId);
  };

  return (
    <group position={[desk.x, 0, desk.z]} rotation={[0, desk.rotationY, 0]}>
      {/* Static furniture (desk, monitor body, chair, shadow) is instanced in Furniture.tsx. */}
      <mesh position={[0, 1.06, 0.613]}>
        <planeGeometry args={[0.58, 0.32]} />
        <meshStandardMaterial
          ref={screenMat}
          color={style.screenOn ? statusColor : "#23232a"}
          emissive={style.screenOn ? statusColor : "#000000"}
          emissiveIntensity={style.screenOn ? 0.9 : 0}
          side={2}
        />
      </mesh>

      {/* desk lamp: its bulb shows the status from any camera angle */}
      <mesh position={[0.55, 1.05, 0.62]}>
        <icosahedronGeometry args={[0.07, 0]} />
        <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={status === "idle" ? 0.15 : 0.9} flatShading />
      </mesh>

      {/* status ring on the floor */}
      {(selected || style.glow || hovered) && (
        <mesh ref={ring} position={[0, 0.06, -0.25]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.62, selected ? 0.74 : 0.69, 24]} />
          <meshBasicMaterial color={selected ? "#ffffff" : statusColor} transparent opacity={selected ? 0.95 : 0.7} depthWrite={false} />
        </mesh>
      )}

      {/* the bean */}
      <group
        position={[0, 0, -0.3]}
        onClick={onSelect}
        onPointerOver={(e) => {
          e.stopPropagation();
          hover(desk.agentId);
        }}
        onPointerOut={() => hover(null)}
      >
        <group ref={body}>
          <mesh position={[0, 0.78, 0]}>
            <capsuleGeometry args={[0.24, 0.28, 3, 10]} />
            <meshStandardMaterial
              color={bodyColor}
              flatShading
              emissive={style.glow ? STATUS_HEX.waiting_human : "#000000"}
              emissiveIntensity={style.glow ? 0.35 : 0}
              transparent={style.dim}
              opacity={style.dim ? 0.6 : 1}
            />
          </mesh>
          <mesh position={[0, 1.24, 0.02]}>
            <icosahedronGeometry args={[0.22, 1]} />
            <meshStandardMaterial color={bodyColor} flatShading transparent={style.dim} opacity={style.dim ? 0.6 : 1} />
          </mesh>
          {/* eyes look at the desk (+z) */}
          {[-0.08, 0.08].map((x) => (
            <mesh key={x} position={[x, 1.28, 0.19]}>
              <sphereGeometry args={[0.048, 8, 6]} />
              <meshBasicMaterial color="#2b2622" />
            </mesh>
          ))}
          <mesh ref={armL} position={[-0.27, 0.9, 0.05]} rotation={[-1.1, 0, 0.15]}>
            <capsuleGeometry args={[0.06, 0.22, 2, 6]} />
            <meshStandardMaterial color={bodyColor} flatShading />
          </mesh>
          <mesh ref={armR} position={[0.27, 0.9, 0.05]} rotation={[-1.1, 0, -0.15]}>
            <capsuleGeometry args={[0.06, 0.22, 2, 6]} />
            <meshStandardMaterial color={bodyColor} flatShading />
          </mesh>
          {style.glow && (
            <mesh ref={halo} position={[0, 1.05, 0]}>
              <sphereGeometry args={[0.6, 16, 12]} />
              <meshBasicMaterial color={STATUS_HEX.waiting_human} transparent opacity={0.25} depthWrite={false} />
            </mesh>
          )}
        </group>

      </group>
    </group>
  );
});
