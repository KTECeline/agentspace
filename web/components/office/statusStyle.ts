import type { AgentStatus } from "@agentspace/spec-types";

export type Motion = "breathe" | "bob" | "type" | "still" | "cheer" | "shake";

export interface StatusStyle {
  motion: Motion;
  /** Short bubble text over the avatar; null = no bubble. `{detail}` is replaced by the status detail. */
  bubble: string | null;
  /** Emissive halo + beacon (needs attention). */
  glow: boolean;
  /** Fade the avatar (not doing anything useful right now). */
  dim: boolean;
  /** Monitor screen is on. */
  screenOn: boolean;
}

export const STATUS_STYLE: Record<AgentStatus, StatusStyle> = {
  idle: { motion: "breathe", bubble: null, glow: false, dim: false, screenOn: false },
  thinking: { motion: "bob", bubble: "…", glow: false, dim: false, screenOn: true },
  using_tool: { motion: "type", bubble: "{detail}", glow: false, dim: false, screenOn: true },
  waiting: { motion: "still", bubble: "waiting", glow: false, dim: true, screenOn: false },
  blocked: { motion: "still", bubble: "blocked", glow: false, dim: true, screenOn: false },
  waiting_human: { motion: "bob", bubble: "needs you", glow: true, dim: false, screenOn: true },
  done: { motion: "cheer", bubble: "✓", glow: false, dim: false, screenOn: false },
  error: { motion: "shake", bubble: "!", glow: false, dim: false, screenOn: true },
};

/** Bubble text for an agent, or null. Tool names are shortened so bubbles stay small. */
export function bubbleText(status: AgentStatus, detail: string | null): string | null {
  const tpl = STATUS_STYLE[status].bubble;
  if (tpl === null) return null;
  if (!tpl.includes("{detail}")) return tpl;
  const d = (detail ?? "").trim();
  if (!d) return "working";
  return d.length > 18 ? d.slice(0, 17) + "…" : d;
}

/**
 * Per-frame pose offsets for a motion at time t (seconds). Pure, so it's testable and so the
 * reduced-motion path can just skip it.
 */
export function pose(motion: Motion, t: number, phase: number): { y: number; tilt: number; arms: number; x: number } {
  const s = t + phase;
  switch (motion) {
    case "breathe":
      return { y: Math.sin(s * 1.6) * 0.015, tilt: 0, arms: 0, x: 0 };
    case "bob":
      return { y: Math.abs(Math.sin(s * 3)) * 0.06, tilt: Math.sin(s * 1.5) * 0.08, arms: 0, x: 0 };
    case "type":
      return { y: Math.sin(s * 10) * 0.01, tilt: 0.12, arms: Math.sin(s * 22) * 0.35, x: 0 };
    case "still":
      return { y: 0, tilt: -0.05, arms: 0, x: 0 };
    case "cheer": {
      const hop = Math.max(0, Math.sin(s * 2.2)) ** 6;
      return { y: hop * 0.18, tilt: 0, arms: -1.2 * hop, x: 0 };
    }
    case "shake":
      return { y: 0, tilt: 0, arms: 0, x: Math.sin(s * 30) * 0.03 * (Math.sin(s * 2) > 0 ? 1 : 0) };
  }
}
