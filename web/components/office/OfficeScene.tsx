"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, MapControls } from "@react-three/drei";
import type { OrthographicCamera } from "three";
import { useShallow } from "zustand/react/shallow";
import { Maximize } from "lucide-react";
import { layoutOffice, type OfficeLayout } from "@/lib/layout";
import { useOffice } from "@/lib/store";
import { useThrottled } from "@/lib/useThrottled";
import { SCENE, assignBodyColors } from "./palette";
import { Furniture } from "./Furniture";
import { LabelLayer, LabelProjector, type AnchorMap } from "./Labels";
import { Packets } from "./Packets";
import { Room } from "./Room";
import { Workstation } from "./Workstation";

const CAMERA_DIR: [number, number, number] = [1, 1.15, 1];
const SHOW_NAMES_UP_TO = 12;

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The 3D office. Loaded lazily (next/dynamic) so the 2D view never pays for three.js. */
export default function OfficeScene({ showFps = false }: { showFps?: boolean }) {
  const dark = useMedia("(prefers-color-scheme: dark)");
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const palette = dark ? SCENE.dark : SCENE.light;
  const [fitNonce, setFitNonce] = useState(0);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const [anchors] = useState<AnchorMap>(() => new Map());
  // Written straight to the DOM twice a second, so the FPS meter itself never re-renders React.
  const writeFps = useCallback((fps: number) => {
    if (fpsRef.current) fpsRef.current.textContent = String(fps);
  }, []);
  const select = useOffice((s) => s.select);

  // Only team membership and first-seen order affect layout, so status updates don't recompute it.
  const layoutKey = useOffice(
    useShallow((s) =>
      Object.values(s.agents)
        .map((a) => `${a.agent_id}\u0000${a.team_id ?? ""}\u0000${s.firstSeen[a.agent_id] ?? ""}`)
        .sort(),
    ),
  );
  const layoutSignature = layoutKey.join("|");
  const layout = useMemo(() => {
    const { agents, firstSeen } = useOffice.getState();
    return layoutOffice(Object.values(agents), firstSeen);
    // layoutSignature captures everything layoutOffice reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature]);

  const teamCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of Object.values(layout.desks)) counts[d.roomKey] = (counts[d.roomKey] ?? 0) + 1;
    return counts;
  }, [layout]);
  const showNames = Object.keys(layout.desks).length <= SHOW_NAMES_UP_TO;
  const deskList = useMemo(() => Object.values(layout.desks), [layout]);
  const colors = useMemo(() => {
    const { firstSeen } = useOffice.getState();
    const ids = Object.keys(layout.desks).sort((a, b) => (firstSeen[a] ?? 0) - (firstSeen[b] ?? 0));
    return assignBodyColors(ids);
  }, [layout]);

  return (
    <div className="relative h-full min-h-[420px] w-full overflow-hidden rounded-xl border border-border" style={{ background: palette.background }}>
      <Canvas
        orthographic
        dpr={[1, 2]}
        camera={{ position: [20, 23, 20], zoom: 40, near: 0.1, far: 500 }}
        onPointerMissed={() => select(null)}
        aria-label="3D office. Use the agent list for keyboard access."
      >
        <AdaptiveDpr pixelated={false} />
        <ambientLight intensity={dark ? 0.9 : 0.75} color={dark ? "#f1e6da" : "#fff6e8"} />
        <hemisphereLight args={[dark ? "#ffd9b0" : "#fff1dc", dark ? "#2a2018" : "#d8c3a0", dark ? 0.9 : 0.8]} />
        <directionalLight position={[8, 14, 6]} intensity={dark ? 1.2 : 1.3} color={dark ? "#ffe8d2" : "#ffffff"} />
        <Floor layout={layout} color={palette.floor} />
        {layout.rooms.map((room) => (
          <Room key={room.key} room={room} palette={palette} dark={dark} />
        ))}
        <Furniture desks={deskList} palette={palette} />
        {deskList.map((desk) => (
          <Workstation key={desk.agentId} desk={desk} reducedMotion={reducedMotion} bodyColor={colors[desk.agentId]!} />
        ))}
        <Packets desks={layout.desks} color={palette.packet} reducedMotion={reducedMotion} />
        <CameraRig layout={layout} fitNonce={fitNonce} />
        <LabelProjector anchors={anchors} />
        {showFps && <FpsMeter onFps={writeFps} />}
      </Canvas>
      <LabelLayer layout={layout} anchors={anchors} showNames={showNames} teamCounts={teamCounts} />

      <div className="absolute right-3 top-3 flex items-center gap-2">
        {showFps && (
          <span className="rounded-md bg-surface/90 px-2 py-1 font-mono text-xs tabular-nums text-foreground" aria-live="off">
            <span ref={fpsRef}>–</span> fps
          </span>
        )}
        <button
          type="button"
          onClick={() => setFitNonce((n) => n + 1)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface/90 px-3 text-sm text-foreground shadow-sm hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Maximize aria-hidden className="size-4" />
          Fit
        </button>
      </div>
      <AgentRoster />
    </div>
  );
}

function Floor({ layout, color }: { layout: OfficeLayout; color: string }) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const pad = 6;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(minX + maxX) / 2, 0, (minZ + maxZ) / 2]}>
      <planeGeometry args={[maxX - minX + pad * 2, maxZ - minZ + pad * 2]} />
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  );
}

/** Isometric orthographic camera. Fits the office on first layout, on new rooms, and on "Fit". */
function CameraRig({ layout, fitNonce }: { layout: OfficeLayout; fitNonce: number }) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const controls = useRef<React.ComponentRef<typeof MapControls>>(null);
  const roomCount = layout.rooms.length;

  useEffect(() => {
    const camera = get().camera as OrthographicCamera;
    const { minX, maxX, minZ, maxZ } = layout.bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const w = maxX - minX;
    const d = maxZ - minZ;
    // Projected extent of the floor rectangle in an isometric view.
    const horiz = (w + d) * 0.7071;
    const vert = (w + d) * 0.7071 * 0.62 + 2.5;
    camera.zoom = Math.max(8, Math.min(90, Math.min(size.width / (horiz * 1.08), size.height / (vert * 1.15))));
    const len = Math.hypot(...CAMERA_DIR);
    camera.position.set(cx + (CAMERA_DIR[0] / len) * 40, (CAMERA_DIR[1] / len) * 40, cz + (CAMERA_DIR[2] / len) * 40);
    camera.lookAt(cx, 0, cz);
    camera.updateProjectionMatrix();
    controls.current?.target.set(cx, 0, cz);
    controls.current?.update();
    // Refit when rooms are added, the canvas resizes, or the user presses Fit, but not on every status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCount, fitNonce, size.width, size.height]);

  return <MapControls ref={controls} makeDefault enableRotate={false} screenSpacePanning minZoom={6} maxZoom={140} zoomToCursor />;
}

function FpsMeter({ onFps }: { onFps: (fps: number) => void }) {
  const stats = useRef({ frames: 0, since: 0 });
  useFrame(() => {
    const st = stats.current;
    const now = performance.now();
    if (!st.since) st.since = now;
    st.frames += 1;
    if (now - st.since >= 500) {
      onFps(Math.round((st.frames * 1000) / (now - st.since)));
      st.frames = 0;
      st.since = now;
    }
  });
  return null;
}

/**
 * Keyboard and screen-reader access to the scene: a list of agent buttons that is hidden until
 * something in it gets focus. The canvas itself can't be tabbed through.
 */
function AgentRoster() {
  const byId = useThrottled(useOffice((s) => s.agents), 500);
  const agents = useMemo(() => Object.values(byId).map((a) => [a.agent_id, a.name, a.status] as const), [byId]);
  const select = useOffice((s) => s.select);
  return (
    <nav aria-label="Agents in the office" className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:left-3 focus-within:top-3 focus-within:max-h-[80%] focus-within:overflow-y-auto focus-within:rounded-lg focus-within:border focus-within:border-border focus-within:bg-surface focus-within:p-2 focus-within:shadow-lg">
      <ul className="flex flex-col gap-1">
        {agents.map(([id, name, status]) => (
          <li key={id}>
            <button
              type="button"
              onClick={() => select(id)}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span data-status={status} aria-hidden className="size-2 rounded-full bg-[var(--st-dot)]" />
              {name} <span className="text-muted">({status.replace("_", " ")})</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
