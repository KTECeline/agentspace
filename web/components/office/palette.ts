import type { AgentStatus } from "@agentspace/spec-types";

/** 3D scene colors for the "cozy low-poly office" (brand.md). Hex, because three.js wants sRGB hex. */
export const SCENE = {
  light: {
    background: "#f6efe2",
    floor: "#e9dcc4",
    wall: "#f8f1e4",
    wallTrim: "#e3d4bb",
    wood: "#d9a86c",
    woodDark: "#b9844d",
    chair: "#6f7d8c",
    monitor: "#3a3a40",
    plantPot: "#c9714f",
    plant: "#7fae7a",
    shadow: "#6b5a44",
    packet: "#ff9f6e",
  },
  dark: {
    background: "#241e18",
    floor: "#352d26",
    wall: "#5d4d3e",
    wallTrim: "#6e5b48",
    wood: "#a8784a",
    woodDark: "#86603a",
    chair: "#55606c",
    monitor: "#1f1f24",
    plantPot: "#a85d40",
    plant: "#5f8f5b",
    shadow: "#000000",
    packet: "#ffb088",
  },
};

export type ScenePalette = (typeof SCENE)["light"];

/** Pastel rugs, one per team. */
export const RUGS = ["#f4c9b6", "#c9dcf2", "#cfe8c9", "#efdca8", "#e3cdf0", "#bfe3e0", "#f2c6d6", "#dcd3c2"];
export const RUGS_DARK = ["#8a5f4e", "#5a6f8c", "#5e7d5a", "#8a7646", "#76608a", "#4f7a76", "#8a5a70", "#736a55"];

/** Bean-avatar body colors. */
export const BODIES = ["#f59e84", "#8fb8ef", "#90cf95", "#f3c567", "#c7a0ea", "#7fcfc8", "#f09ab8", "#b6a58d", "#9aa7f0", "#e8a06b"];

/** Status colors in the scene (screens, rings, bubbles). Same hues as the CSS status tokens. */
export const STATUS_HEX: Record<AgentStatus, string> = {
  idle: "#b9ad9c",
  thinking: "#7f8cf0",
  using_tool: "#f2b544",
  waiting: "#8fa3b8",
  blocked: "#8fa3b8",
  waiting_human: "#c47ae6",
  done: "#6fbf7f",
  error: "#ec6b5a",
};

/**
 * Body colors for agents in first-seen order: each agent's hashed color unless a teammate
 * already has it, then the next free one. Deterministic, and neighbours never look alike
 * until the palette runs out.
 */
export function assignBodyColors(orderedIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<number>();
  for (const id of orderedIds) {
    let i = hashIndex(id, BODIES.length);
    if (used.size < BODIES.length) while (used.has(i)) i = (i + 1) % BODIES.length;
    used.add(i);
    out[id] = BODIES[i]!;
  }
  return out;
}

/** Stable small hash (FNV-1a) so an agent keeps its color everywhere. */
export function hashIndex(id: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}
