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
