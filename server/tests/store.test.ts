import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSpaceEvent } from "@agentspace/spec-types";
import { SqliteStore } from "../src/store/index.js";
import type { Store } from "../src/store/types.js";
import { ev } from "./helpers.js";

/**
 * The storage contract. Every backend must pass this suite: SQLite always, Postgres when
 * TEST_DATABASE_URL points at a disposable database.
 */
const backends: [string, () => Promise<Store>][] = [["sqlite", async () => new SqliteStore(":memory:")]];
if (process.env.TEST_DATABASE_URL) {
  backends.push([
    "postgres",
    async () => {
      const { PostgresStore } = await import("../src/store/postgres.js");
      const store = await PostgresStore.connect(process.env.TEST_DATABASE_URL!);
      await (store as unknown as { reset(): Promise<void> }).reset();
      return store;
    },
  ]);
}

const request = (id: string, extra: Partial<AgentSpaceEvent> = {}, timeout_s?: number) =>
  ev({ type: "approval.requested", agent_id: "eng", team_id: "t", ...extra, data: { approval_id: id, reason: "Merge?", payload: { diff: "+1" }, ...(timeout_s ? { timeout_s } : {}) } } as never);

describe.each(backends)("%s store", (_name, make) => {
  let store: Store;
  beforeEach(async () => {
    store = await make();
  });
  afterEach(async () => store.close());

  it("keeps reported, estimated and unpriced costs apart in the totals (D-037)", async () => {
    const llm = (extra: Partial<AgentSpaceEvent>) => ev({ type: "llm.call", agent_id: "a", data: {}, ...extra } as never);
    await store.insert([
      llm({ tokens_in: 100, cost_usd: 0.5 }), // reported
      llm({ tokens_in: 100, cost_usd: 0.25, cost_source: "estimated" }),
      llm({ tokens_in: 100, cost_source: "reported" }), // cost reported on another event
      llm({ tokens_in: 100, model: "unknown" }), // unpriced
      llm({ cost_usd: 1, cost_source: "reported" }), // e.g. a session's billed cost, no tokens
      ev({ type: "agent.status", agent_id: "a", cost_usd: 9, data: { status: "thinking" } } as never), // not an llm.call
    ]);
    const totals = { tokens_in: 400, cost_usd: 1.75, cost_estimated_usd: 0.25, unpriced_calls: 1 };
    expect((await store.agents("default"))[0]).toMatchObject(totals);
    expect(await store.run("default", "run-1")).toMatchObject(totals);
  });

  it("aggregates stats for the dashboard within a time window", async () => {
    const at = (m: number) => `2026-09-2${m < 60 ? "3" : "4"}T10:${String(m % 60).padStart(2, "0")}:00.000Z`;
    const llm = (run_id: string, agent_id: string, model: string, ts: string, extra: Partial<AgentSpaceEvent>, duration_ms: number) =>
      ev({ type: "llm.call", run_id, agent_id, model, ts, ...extra, data: { duration_ms } } as never);
    await store.insert([
      ev({ type: "run.started", run_id: "r1", ts: at(0), data: { name: "one" } }),
      ev({ type: "agent.registered", run_id: "r1", agent_id: "a", ts: at(0), data: { name: "Alice" } }),
      llm("r1", "a", "claude-haiku-4-5", at(1), { tokens_in: 100, tokens_out: 10, cost_usd: 0.3, cost_source: "estimated" }, 100),
      llm("r1", "b", "gpt-5", at(2), { tokens_in: 50, tokens_out: 5, cost_usd: 0.1 }, 300),
      llm("r1", "b", "scripted-fake", at(3), { tokens_in: 10 }, 200),
      ev({ type: "tool.result", run_id: "r1", agent_id: "a", ts: at(4), data: { tool_name: "search", call_id: "c1", ok: true, duration_ms: 50 } }),
      ev({ type: "tool.result", run_id: "r1", agent_id: "a", ts: at(5), data: { tool_name: "search", call_id: "c2", ok: false, duration_ms: 900 } }),
      ev({ type: "tool.result", run_id: "r1", agent_id: "a", ts: at(6), data: { tool_name: "fetch", call_id: "c3", ok: true, duration_ms: 20 } }),
      ev({ type: "error", run_id: "r1", agent_id: "a", ts: at(7), data: { message: "boom" } }),
      ev({ type: "run.finished", run_id: "r1", ts: at(8), data: { status: "error" } }),
      ev({ type: "run.started", run_id: "r2", ts: at(60), data: { name: "two" } }),
      llm("r2", "a", "claude-haiku-4-5", at(61), { tokens_in: 1000, tokens_out: 100, cost_usd: 1, cost_source: "estimated" }, 400),
      ev({ type: "run.finished", run_id: "r2", ts: at(62), data: { status: "ok" } }),
    ]);

    const all = await store.stats("default", { since: null, until: null });
    expect(all.totals).toMatchObject({
      calls: 4,
      tokens_in: 1160,
      cost_usd: 1.4,
      cost_estimated_usd: 1.3,
      unpriced_calls: 1,
      runs: 2,
      runs_ok: 1,
      runs_failed: 1,
      error_rate: 0.5,
      errors: 1,
      tool_calls: 3,
      tool_errors: 1,
      p50_ms: 200,
      p95_ms: 400,
    });
    expect(all.by_run.map((r) => [r.run_id, r.name, r.status, r.calls, r.errors])).toEqual([
      ["r2", "two", "ok", 1, 0],
      ["r1", "one", "error", 3, 1],
    ]);
    expect(all.by_agent.map((a) => [a.agent_id, a.name, a.calls, a.errors])).toEqual([
      ["a", "Alice", 2, 1],
      ["b", "b", 2, 0],
    ]);
    expect(all.by_model.map((m) => m.model)).toEqual(["claude-haiku-4-5", "gpt-5", "scripted-fake"]);
    expect(all.by_day.map((d) => [d.day, d.calls])).toEqual([
      ["2026-09-23", 3],
      ["2026-09-24", 1],
    ]);
    expect(all.slowest_tools).toEqual([
      { tool_name: "search", calls: 2, errors: 1, p50_ms: 50, p95_ms: 900, max_ms: 900 },
      { tool_name: "fetch", calls: 1, errors: 0, p50_ms: 20, p95_ms: 20, max_ms: 20 },
    ]);

    const day1 = await store.stats("default", { since: "2026-09-23T00:00:00.000Z", until: "2026-09-24T00:00:00.000Z" });
    expect(day1.totals).toMatchObject({ calls: 3, runs: 1, cost_usd: 0.4 });
    expect(day1.by_run.map((r) => r.run_id)).toEqual(["r1"]);
    expect((await store.stats("other", { since: null, until: null })).totals.calls).toBe(0);
  });

  it("returns baseline rows: the newest successful runs of a workflow, with each agent's tool calls (D-044)", async () => {
    const run = (id: string, name: string, minute: number, status: "ok" | "error", tools: Record<string, number>) => [
      ev({ type: "run.started", run_id: id, ts: `2026-10-06T10:${String(minute).padStart(2, "0")}:00Z`, data: { name } }),
      ...Object.entries(tools).flatMap(([agent, n]) => [
        ev({ type: "agent.status", run_id: id, agent_id: agent, data: { status: "thinking" } }),
        ...Array.from({ length: n }, (_, i) => ev({ type: "tool.call", run_id: id, agent_id: agent, data: { tool_name: "t", call_id: `${id}${agent}${i}` } })),
      ]),
      ev({ type: "llm.call", run_id: id, agent_id: "a", tokens_in: 10 * minute, tokens_out: 1, cost_usd: 0.01, data: {} }),
      ev({ type: "run.finished", run_id: id, data: { status } }),
    ];
    await store.insert([
      ...run("r1", "ship", 1, "ok", { a: 2 }),
      ...run("r2", "ship", 2, "error", { a: 9 }),
      ...run("r3", "ship", 3, "ok", { a: 1, b: 0 }),
      ...run("r4", "ship", 4, "ok", { a: 3 }),
      ...run("r5", "triage", 5, "ok", { a: 7 }),
    ]);
    const rows = await store.baselineRows("default", "ship", 2);
    expect(rows.runs).toEqual([
      { run_id: "r4", tokens: 41, cost_usd: 0.01 },
      { run_id: "r3", tokens: 31, cost_usd: 0.01 },
    ]);
    const agents = [...rows.agents].sort((x, y) => `${x.run_id}${x.agent_id}`.localeCompare(`${y.run_id}${y.agent_id}`));
    expect(agents).toEqual([
      { run_id: "r3", agent_id: "a", tool_calls: 1 },
      { run_id: "r3", agent_id: "b", tool_calls: 0 },
      { run_id: "r4", agent_id: "a", tool_calls: 3 },
    ]);
    expect(await store.baselineRows("default", "nothing", 5)).toEqual({ runs: [], agents: [] });
  });

  it("inserts idempotently and projects agents and runs", async () => {
    const batch = [ev({ type: "run.started", data: { name: "r" } }), ev({ type: "agent.status", agent_id: "a", data: { status: "thinking" } })];
    const first = await store.insert(batch);
    expect(first.inserted).toHaveLength(2);
    const again = await store.insert(batch);
    expect(again).toMatchObject({ duplicates: 2, inserted: [] });
    expect((await store.agents("default"))[0]).toMatchObject({ agent_id: "a", status: "thinking" });
    expect((await store.run("default", "run-1"))?.control).toBe("running");
  });

  it("projects approval requests and resolves them exactly once", async () => {
    const changes = await store.insert([request("ap1")]);
    expect(changes.approvals).toHaveLength(1);
    expect(await store.approval("default", "ap1")).toMatchObject({ status: "pending", reason: "Merge?", payload: { diff: "+1" }, agent_id: "eng" });

    const first = await store.resolveApproval("default", "ap1", "approved", { comment: "LGTM", by: "operator-1" });
    expect(first.result).toBe("resolved");
    if (first.result !== "resolved") return;
    expect(first.approval).toMatchObject({ status: "approved", comment: "LGTM", resolved_by: "operator-1" });
    expect(first.changes.inserted.map((e) => e.type)).toEqual(["approval.resolved"]);

    const second = await store.resolveApproval("default", "ap1", "rejected", {});
    expect(second.result).toBe("conflict");
    const events = await store.runEvents("default", "run-1");
    expect(events.filter((e) => e.type === "approval.resolved")).toHaveLength(1); // no duplicate
    expect(await store.resolveApproval("default", "nope", "approved", {})).toEqual({ result: "not_found" });
  });

  it("times out approvals after their deadline, and late decisions don't count", async () => {
    await store.insert([request("ap2", { ts: "2026-01-01T00:00:00.000Z" }, 60)]);
    expect(await store.expiredApprovals(new Date("2026-01-01T00:00:30.000Z"))).toHaveLength(0);
    expect((await store.expiredApprovals(new Date("2026-01-01T00:02:00.000Z"))).map((a) => a.approval_id)).toEqual(["ap2"]);
    const late = await store.resolveApproval("default", "ap2", "approved", { now: new Date("2026-01-01T00:02:00.000Z") });
    expect(late.result).toBe("conflict");
    expect((await store.approval("default", "ap2"))?.status).toBe("timeout");
    expect(await store.approvals("default", "pending")).toHaveLength(0);
  });

  it("controls runs: pause, resume, cancel (final)", async () => {
    await store.insert([ev({ type: "run.started", data: {} })]);
    const pause = await store.setControl("default", "run-1", "pause", { by: "op" });
    expect(pause.result === "ok" && pause.run.control).toBe("paused");
    expect(await store.controls("default", ["run-1", "other"])).toEqual({ "run-1": "paused" });
    expect((await store.setControl("default", "run-1", "pause", {})).result).toBe("conflict");
    expect((await store.setControl("default", "run-1", "resume", {})).result).toBe("ok");
    expect(await store.controls("default", ["run-1"])).toEqual({});
    expect((await store.setControl("default", "run-1", "cancel", {})).result).toBe("ok");
    expect((await store.setControl("default", "run-1", "resume", {})).result).toBe("conflict");
    expect(await store.controls("default", ["run-1"])).toEqual({ "run-1": "cancelled" });
    const controlEvents = (await store.runEvents("default", "run-1")).filter((e) => e.type === "run.control");
    expect(controlEvents.map((e) => (e.data as { action: string }).action)).toEqual(["pause", "resume", "cancel"]);
    expect((await store.setControl("default", "missing", "pause", {})).result).toBe("not_found");
  });

  it("prunes old data but keeps pending approvals", async () => {
    await store.insert([ev({ type: "message", data: {} }), request("ap3")]);
    const later = new Date(Date.now() + 30 * 86_400_000);
    expect(await store.prune(7, later)).toBe(2);
    expect(await store.recentEvents("default")).toHaveLength(0);
    expect((await store.approval("default", "ap3"))?.status).toBe("pending");
  });
});

describe("sqlite migrations", () => {
  it("adds the cost columns to a database created before D-037", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const path = join(mkdtempSync(join(tmpdir(), "agentspace-migrate-")), "old.db");
    const first = new SqliteStore(path);
    await first.insert([ev({ type: "llm.call", agent_id: "a", tokens_in: 5, cost_usd: 0.1, data: {} } as never)]);
    await first.close();
    const raw = new Database(path);
    for (const t of ["agents", "runs"]) for (const c of ["cost_estimated_usd", "unpriced_calls"]) raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    raw.close();

    const store = new SqliteStore(path);
    await store.insert([ev({ type: "llm.call", agent_id: "a", tokens_in: 5, cost_usd: 0.2, cost_source: "estimated", data: {} } as never)]);
    expect((await store.agents("default"))[0]).toMatchObject({ cost_usd: 0.1 + 0.2, cost_estimated_usd: 0.2, unpriced_calls: 0 });
    await store.close();
  });
});
