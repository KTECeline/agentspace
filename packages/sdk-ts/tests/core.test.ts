import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentspace from "../src/index.js";
import { FakeCollector, assertValid, sleep } from "./helpers.js";

let collector: FakeCollector | null = null;
afterEach(async () => {
  await agentspace.shutdown(500);
  await collector?.stop();
  collector = null;
  vi.unstubAllEnvs();
});

async function setup(opts: agentspace.InitOptions = {}) {
  collector = await new FakeCollector().start();
  agentspace.init({ url: collector.url, flushIntervalMs: 10, ...opts });
  return collector;
}

describe("before init", () => {
  it("everything is a harmless no-op", async () => {
    expect(agentspace.isInitialized()).toBe(false);
    expect(agentspace.emit("message", { text: "hi" })).toBeNull();
    agentspace.setStatus("thinking");
    agentspace.handoff("x");
    expect(agentspace.run("r", () => agentspace.agent("A", () => agentspace.step("s", () => 7)))).toBe(7);
    expect(await agentspace.agent("A", async () => 8)).toBe(8);
    expect(await agentspace.flush()).toBe(true);
  });
});

describe("manual API", () => {
  it("emits valid, linked events with handoffs", async () => {
    const c = await setup({ workspace: "ws1" });
    const engineer = agentspace.wrapAgent({ name: "Engineer", team: "Engineering", role: "fixes bugs" }, (bug: string) =>
      agentspace.step("reproduce", () => {
        agentspace.emit("tool.call", { tool_name: "pytest", call_id: "c1" });
        return `fixed ${bug}`;
      }),
    );
    const result = agentspace.run("fix-bug", () =>
      agentspace.agent({ name: "Manager", team: "Engineering" }, () => {
        agentspace.setStatus("thinking", "planning");
        return engineer("#12");
      }),
    );
    expect(result).toBe("fixed #12");
    expect(await agentspace.flush()).toBe(true);

    const ev = c.events;
    assertValid(ev);
    expect(new Set(ev.map((e) => e.workspace))).toEqual(new Set(["ws1"]));
    expect(new Set(ev.map((e) => e.run_id)).size).toBe(1);
    expect(ev[0]!.type).toBe("run.started");
    expect(ev.at(-1)!.type).toBe("run.finished");
    const reg = Object.fromEntries(c.ofType("agent.registered").map((e) => [e.agent_id, e]));
    expect(Object.keys(reg).sort()).toEqual(["engineer", "manager"]);
    expect(reg.engineer!.team_id).toBe("engineering");
    expect(reg.engineer!.data.role).toBe("fixes bugs");
    expect(c.ofType("handoff")[0]!.data).toEqual({ from_agent_id: "manager", to_agent_id: "engineer" });
    const steps = Object.fromEntries(c.ofType("step.started").map((e) => [e.data.name, e]));
    const tool = c.ofType("tool.call")[0]!;
    expect(tool.agent_id).toBe("engineer");
    expect(tool.parent_id).toBe(steps.reproduce!.data.step_id);
    expect(steps.reproduce!.parent_id).toBe(steps.Engineer!.data.step_id);
    expect(steps.Engineer!.parent_id).toBe(steps.Manager!.data.step_id);
    const statuses = c.ofType("agent.status").map((e) => `${e.agent_id}:${e.data.status}`);
    expect(statuses.slice(-2)).toEqual(["engineer:done", "manager:done"]);
  });

  it("passes user errors through unchanged and records them (sync and async)", async () => {
    const c = await setup();
    expect(() => agentspace.run("r", () => agentspace.agent("QA", () => { throw new TypeError("boom"); }))).toThrow(TypeError);
    await expect(agentspace.agent("QA2", async () => { throw new RangeError("async boom"); })).rejects.toThrow(RangeError);
    await agentspace.flush();
    assertValid(c.events);
    expect(c.ofType("error").map((e) => e.data.kind)).toEqual(expect.arrayContaining(["TypeError", "RangeError"]));
    expect(c.ofType("run.finished")[0]!.data.status).toBe("error");
    expect(c.ofType("step.finished").every((e) => e.data.ok === false)).toBe(true);
  });

  it("keeps concurrent async agents apart", async () => {
    const c = await setup();
    const worker = async (name: string) => {
      for (let i = 0; i < 3; i++) {
        agentspace.emit("message", { text: name }, { summary: name });
        await sleep(1);
      }
    };
    await agentspace.run("parallel", () =>
      Promise.all([agentspace.agent({ name: "alpha", team: "r" }, () => worker("alpha")), agentspace.agent({ name: "beta", team: "r" }, () => worker("beta"))]),
    );
    await agentspace.flush();
    assertValid(c.events);
    const msgs = c.ofType("message");
    expect(msgs).toHaveLength(6);
    for (const m of msgs) expect(m.agent_id).toBe(m.summary);
    expect(agentspace.hasAsyncContext).toBe(true);
  });

  it("does not send content unless asked, and applies redaction", async () => {
    let c = await setup();
    agentspace.run("r", () => 1, { input: { secret: "prompt" } });
    await agentspace.flush();
    expect(c.ofType("run.started")[0]!.data).not.toHaveProperty("input");
    await agentspace.shutdown();
    await c.stop();

    const seen: string[] = [];
    c = collector = await new FakeCollector().start();
    agentspace.init({
      url: c.url,
      flushIntervalMs: 10,
      captureContent: true,
      redact: (field, v) => {
        seen.push(field);
        return { ...(v as object), api_key: "***" };
      },
    });
    agentspace.run("r", () => 1, { input: { q: "hi", api_key: "sk-1" } });
    await agentspace.flush();
    expect(seen).toEqual(["run.input"]);
    expect(c.ofType("run.started")[0]!.data.input).toEqual({ q: "hi", api_key: "***" });
  });

  it("truncates long summaries so events stay valid", async () => {
    const c = await setup();
    agentspace.emit("message", {}, { summary: "x".repeat(5000), model: "m".repeat(1000) });
    await agentspace.flush();
    assertValid(c.events);
  });

  it("can be disabled by env", async () => {
    vi.stubEnv("AGENTSPACE_DISABLED", "1");
    const c = await setup();
    agentspace.emit("message", {});
    await agentspace.flush();
    expect(c.events).toEqual([]);
  });
});

describe("hashArguments", () => {
  it("is stable for equal arguments, whatever the key order or form, and differs otherwise", () => {
    const { hashArguments } = agentspace;
    const a = hashArguments({ path: "cart.py", lines: [1, 2] });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hashArguments({ lines: [1, 2], path: "cart.py" })).toBe(a);
    expect(hashArguments('{"lines": [1, 2], "path": "cart.py"}')).toBe(a);
    expect(hashArguments({ path: "cart.py", lines: [2, 1] })).not.toBe(a);
    expect(hashArguments(undefined)).toMatch(/^[0-9a-f]{16}$/);
    // Bounded cost: beyond the limits differences don't count, but a string's length does.
    const huge = "x".repeat(2_000_000);
    expect(hashArguments(huge)).toBe(hashArguments(`${huge.slice(0, -1)}y`));
    expect(hashArguments(huge)).not.toBe(hashArguments(`${huge}x`));
    const rows = { rows: Array.from({ length: 40_000 }, (_, id) => ({ id, v: "abcdefgh" })) };
    const started = performance.now();
    expect(hashArguments(rows)).toMatch(/^[0-9a-f]{16}$/);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
