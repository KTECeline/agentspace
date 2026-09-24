import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentspace from "../src/index.js";
import { Ring, Transport } from "../src/transport.js";
import { FakeCollector, freePort, sleep } from "./helpers.js";

afterEach(async () => {
  await agentspace.shutdown(300);
  vi.restoreAllMocks();
});

function emitMany(n: number): number[] {
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    agentspace.emit("message", { text: String(i) }, { summary: "load" });
    lat.push(performance.now() - t0);
  }
  return lat;
}

describe("reliability", () => {
  it("never throws and stays fast while the collector is down", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    agentspace.init({ url: `http://127.0.0.1:${await freePort()}`, flushIntervalMs: 10 });
    expect(agentspace.run("offline", () => agentspace.agent("A", () => "ok"))).toBe("ok");
    const lat = emitMany(5000).sort((a, b) => a - b);
    const p99 = lat[Math.floor(lat.length * 0.99)]!;
    expect(p99).toBeLessThan(1); // ms
    await sleep(100);
    const t0 = Date.now();
    expect(await agentspace.flush(5000)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("bounds memory by dropping the oldest events", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    agentspace.init({ url: `http://127.0.0.1:${await freePort()}`, maxQueue: 100 });
    emitMany(1000);
    const s = agentspace.stats();
    expect(s.pending).toBeLessThanOrEqual(100);
    expect(s.dropped).toBeGreaterThanOrEqual(850);
  });

  it("delivers buffered events once the collector comes back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = await freePort();
    agentspace.init({ url: `http://127.0.0.1:${port}`, flushIntervalMs: 10 });
    emitMany(50);
    await sleep(150);
    const c = await new FakeCollector().start(port);
    try {
      for (let i = 0; i < 100 && c.events.length < 51; i++) await sleep(100);
      expect(c.events.length).toBeGreaterThanOrEqual(51); // 50 + run.started
    } finally {
      await c.stop();
    }
  });

  it("a hung collector doesn't stall the event loop", async () => {
    const c = await new FakeCollector().start();
    c.hang = true;
    try {
      agentspace.init({ url: c.url, flushIntervalMs: 5, timeoutMs: 5000 });
      const ticks: number[] = [];
      for (let i = 0; i < 20; i++) {
        emitMany(200);
        const t0 = performance.now();
        await sleep(5);
        ticks.push(performance.now() - t0);
      }
      ticks.sort((a, b) => a - b);
      expect(ticks[10]!).toBeLessThan(50);
    } finally {
      await agentspace.shutdown(100);
      await c.stop();
    }
  });

  it("swallows internal failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await new FakeCollector().start();
    try {
      agentspace.init({ url: c.url });
      const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
        throw new Error("simulated SDK bug");
      });
      expect(agentspace.agent("A", () => agentspace.step("s", () => 42))).toBe(42);
      spy.mockRestore();
      expect(agentspace.emit("message", {})).not.toBeNull();
    } finally {
      await c.stop();
    }
  });

  it("drops 4xx batches instead of retrying", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = await new FakeCollector().start();
    c.status = 400;
    try {
      agentspace.init({ url: c.url, flushIntervalMs: 5 });
      emitMany(10);
      for (let i = 0; i < 50 && agentspace.stats().rejected < 11; i++) await sleep(20);
      expect(agentspace.stats().rejected).toBeGreaterThanOrEqual(11);
      expect(agentspace.stats().pending).toBe(0);
    } finally {
      await c.stop();
    }
  });
});

describe("Transport", () => {
  it("keeps sending after a drain found the queue empty", async () => {
    const c = await new FakeCollector().start();
    const t = new Transport({ endpoint: `${c.url}/v1/events`, maxQueue: 100, maxBatch: 10, flushIntervalMs: 5, timeoutMs: 1000 });
    try {
      await (t as unknown as { drain(): Promise<void> }).drain(); // e.g. a timer firing after a flush
      t.put({ id: "a" });
      expect(await t.flush(1000)).toBe(true);
      expect(c.events).toHaveLength(1);
    } finally {
      await t.shutdown(200);
      await c.stop();
    }
  });
});

describe("Ring", () => {
  it("drops oldest and re-queues at the front", () => {
    const r = new Ring<number>(3);
    expect([r.push(1), r.push(2), r.push(3), r.push(4)]).toEqual([false, false, false, true]);
    expect(r.shift(2)).toEqual([2, 3]);
    expect(r.unshift([7, 8, 9])).toBe(1); // only room for two
    expect(r.shift(10)).toEqual([8, 9, 4]);
  });
});
