import { describe, expect, it } from "vitest";
import { fillDays, formatMs, formatPercent, formatUsdTicks, niceTicks } from "../lib/chart";

describe("chart helpers", () => {
  it("makes round ticks that cover the max", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(0.17)).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
    expect(niceTicks(3.2)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(0.0004)).toEqual([0, 0.0001, 0.0002, 0.0003, 0.0004]);
  });

  it("formats ticks, durations and percentages", () => {
    expect(formatUsdTicks(niceTicks(0.17))).toEqual(["$0", "$0.05", "$0.10", "$0.15", "$0.20"]);
    expect(formatUsdTicks(niceTicks(0.0004))).toEqual(["$0", "$0.0001", "$0.0002", "$0.0003", "$0.0004"]);
    expect(formatUsdTicks(niceTicks(3.2))).toEqual(["$0", "$1", "$2", "$3", "$4"]);
    expect(formatUsdTicks(niceTicks(9))).toEqual(["$0", "$2.50", "$5.00", "$7.50", "$10.00"]);
    expect(formatUsdTicks(niceTicks(4200))).toEqual(["$0", "$2K", "$4K", "$6K"]);
    expect([null, 12.4, 1500, 42_000].map(formatMs)).toEqual(["—", "12 ms", "1.5 s", "42 s"]);
    expect([null, 0, 0.034, 0.5].map(formatPercent)).toEqual(["—", "0%", "3.4%", "50%"]);
  });

  it("fills missing days", () => {
    const days = fillDays([{ day: "2026-09-29", n: 1 }, { day: "2026-10-02", n: 2 }], (day) => ({ day, n: 0 }));
    expect(days.map((d) => `${d.day}:${d.n}`)).toEqual(["2026-09-29:1", "2026-09-30:0", "2026-10-01:0", "2026-10-02:2"]);
  });
});
