import { describe, expect, it } from "vitest";
import { arcPoint } from "../components/office/arc";

describe("handoff packet arc", () => {
  const flight = { from: [0, 1.5, 0] as [number, number, number], to: [10, 1.5, 0] as [number, number, number], start: 0, duration: 1, height: 2 };

  it("starts at the sender and ends at the receiver", () => {
    expect(arcPoint(flight, 0)).toEqual([0, 1.5, 0]);
    const [x, y, z] = arcPoint(flight, 1);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(1.5);
    expect(z).toBeCloseTo(0);
  });

  it("peaks halfway at the arc height", () => {
    const [x, y] = arcPoint(flight, 0.5);
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(3.5);
  });
});
