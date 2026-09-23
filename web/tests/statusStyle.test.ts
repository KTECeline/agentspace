import { describe, expect, it } from "vitest";
import { AGENT_STATUSES } from "@agentspace/spec-types";
import { STATUS_STYLE, bubbleText, pose } from "../components/office/statusStyle";
import { BODIES, STATUS_HEX, assignBodyColors, hashIndex } from "../components/office/palette";

describe("status styles", () => {
  it("cover every status in the spec", () => {
    for (const s of AGENT_STATUSES) {
      expect(STATUS_STYLE[s]).toBeDefined();
      expect(STATUS_HEX[s]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("only the human-waiting status glows", () => {
    expect(AGENT_STATUSES.filter((s) => STATUS_STYLE[s].glow)).toEqual(["waiting_human"]);
  });

  it("bubble text uses the tool name and stays short", () => {
    expect(bubbleText("idle", null)).toBeNull();
    expect(bubbleText("thinking", "asking claude")).toBe("…");
    expect(bubbleText("using_tool", "read_file")).toBe("read_file");
    expect(bubbleText("using_tool", "a_very_long_tool_name_indeed")).toHaveLength(18);
    expect(bubbleText("using_tool", null)).toBe("working");
  });

  it("poses are small and bounded", () => {
    for (const m of ["breathe", "bob", "type", "still", "cheer", "shake"] as const) {
      for (let t = 0; t < 10; t += 0.07) {
        const p = pose(m, t, 0.3);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(0.2);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it("hashIndex is stable and spreads", () => {
    expect(hashIndex("manager", BODIES.length)).toBe(hashIndex("manager", BODIES.length));
    const used = new Set(Array.from({ length: 50 }, (_, i) => hashIndex(`agent-${i}`, BODIES.length)));
    expect(used.size).toBeGreaterThan(6);
  });

  it("assigns distinct body colors until the palette runs out", () => {
    const ids = Array.from({ length: BODIES.length }, (_, i) => `agent-${i}`);
    const colors = assignBodyColors(ids);
    expect(new Set(Object.values(colors)).size).toBe(BODIES.length);
    expect(assignBodyColors(ids)).toEqual(colors);
    expect(Object.keys(assignBodyColors([...ids, "extra"]))).toHaveLength(BODIES.length + 1);
  });
});
