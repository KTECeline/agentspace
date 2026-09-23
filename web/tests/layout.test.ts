import { describe, expect, it } from "vitest";
import { DESKS_PER_ROOM, layoutOffice, type LayoutAgent } from "../lib/layout";

const agents = (spec: [string, string | null][]): LayoutAgent[] => spec.map(([agent_id, team_id]) => ({ agent_id, team_id }));
const order = (list: LayoutAgent[]) => Object.fromEntries(list.map((a, i) => [a.agent_id, i]));

describe("layoutOffice", () => {
  it("puts a team in one room with facing desks", () => {
    const list = agents([["manager", "eng"], ["triage", "eng"], ["engineer", "eng"]]);
    const l = layoutOffice(list, order(list));
    expect(l.rooms).toHaveLength(1);
    expect(new Set(Object.values(l.desks).map((d) => d.roomKey))).toEqual(new Set(["eng"]));
    expect(l.desks.manager!.rotationY).toBe(0);
    expect(l.desks.triage!.rotationY).toBe(Math.PI);
    expect(l.desks.manager!.x).toBe(l.desks.triage!.x); // a facing pair
  });

  it("never moves existing desks when agents or teams are added", () => {
    const first = agents([["a", "eng"], ["b", "eng"], ["c", "research"]]);
    const before = layoutOffice(first, order(first));
    const more = [...first, ...agents([["d", "eng"], ["e", "support"], ["f", "research"], ["g", null]])];
    const after = layoutOffice(more, order(more));
    for (const id of ["a", "b", "c"]) expect(after.desks[id]).toEqual(before.desks[id]);
    expect(after.rooms.slice(0, before.rooms.length)).toEqual(before.rooms);
  });

  it("is independent of input order (only first-seen order matters)", () => {
    const list = agents([["a", "x"], ["b", "y"], ["c", "x"]]);
    const fs = order(list);
    expect(layoutOffice([...list].reverse(), fs)).toEqual(layoutOffice(list, fs));
  });

  it("opens an overflow room when a team outgrows one", () => {
    const list = agents(Array.from({ length: DESKS_PER_ROOM + 3 }, (_, i) => [`a${i}`, "big"] as [string, string]));
    const l = layoutOffice(list, order(list));
    expect(l.rooms.map((r) => r.key)).toEqual(["big", "big#1"]);
    expect(l.desks[`a${DESKS_PER_ROOM}`]!.roomKey).toBe("big#1");
  });

  it("lays out 50 agents in 10 teams with no overlapping desks, inside their rooms", () => {
    const list = agents(Array.from({ length: 50 }, (_, i) => [`a${i}`, `team${i % 10}`] as [string, string]));
    const l = layoutOffice(list, order(list));
    expect(l.rooms).toHaveLength(10);
    const spots = new Set(Object.values(l.desks).map((d) => `${d.x.toFixed(2)},${d.z.toFixed(2)}`));
    expect(spots.size).toBe(50);
    const rooms = Object.fromEntries(l.rooms.map((r) => [r.key, r]));
    for (const d of Object.values(l.desks)) {
      const r = rooms[d.roomKey]!;
      expect(Math.abs(d.x - r.x)).toBeLessThan(r.width / 2);
      expect(Math.abs(d.z - r.z)).toBeLessThan(r.depth / 2);
    }
    expect(l.bounds.maxX).toBeGreaterThan(l.bounds.minX);
  });

  it("handles an empty office", () => {
    const l = layoutOffice([], {});
    expect(l.rooms).toEqual([]);
    expect(l.bounds.maxX).toBeGreaterThan(l.bounds.minX);
  });
});
