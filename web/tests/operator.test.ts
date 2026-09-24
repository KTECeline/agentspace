import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalState } from "@agentspace/spec-types";
import { ApiError, actionError, allowedActions, controlRun, resolveApproval } from "@/lib/collector";
import { liveSource } from "@/lib/sources/live";
import { sortApprovals } from "@/components/operator/Approvals";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("run controls", () => {
  it("offers only what the collector allows", () => {
    expect(allowedActions({ status: "running", control: "running" })).toEqual(["pause", "cancel"]);
    expect(allowedActions({ status: "running", control: "paused" })).toEqual(["resume", "cancel"]);
    expect(allowedActions({ status: "running", control: "cancelled" })).toEqual([]);
    expect(allowedActions({ status: "ok", control: "running" })).toEqual([]);
    expect(allowedActions({ status: "cancelled", control: "cancelled" })).toEqual([]);
  });

  it("sends the token as a Bearer header and the action as JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "r1", control: "paused" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await controlRun("http://c:4800/", "my ws", "r/1", "pause", "tok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://c:4800/v1/workspaces/my%20ws/runs/r%2F1/control");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ action: "pause" });
  });

  it("turns failures into short, actionable messages", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "approval already approved" }), { status: 409 }));
    const err = await resolveApproval("http://c", "default", "a1", "approved", "  ", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(actionError(err, "approve")).toBe("Couldn’t approve: approval already approved.");
    expect(actionError(new ApiError(401, "x"), "approve")).toMatch(/operator token/);
    expect(actionError(new ApiError(403, "x"), "approve")).toMatch(/read-only/);
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("fetch failed")));
    const down = await controlRun("http://c", "default", "r1", "cancel", null).catch((e: unknown) => e);
    expect(actionError(down, "cancel the run")).toMatch(/isn’t reachable/);
  });

  it("omits an empty comment", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await resolveApproval("http://c", "default", "a1", "rejected", "  ", null);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ decision: "rejected" });
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe("approvals inbox", () => {
  const a = (id: string, status: ApprovalState["status"], created: string, resolved: string | null = null): ApprovalState => ({
    workspace: "default",
    approval_id: id,
    run_id: "r1",
    agent_id: "eng",
    team_id: null,
    reason: id,
    payload: null,
    status,
    comment: null,
    resolved_by: null,
    created_at: created,
    expires_at: null,
    resolved_at: resolved,
  });

  it("lists pending oldest first, then the latest decisions", () => {
    const { pending, recent } = sortApprovals([
      a("p2", "pending", "2026-09-24T10:02:00Z"),
      a("d1", "approved", "2026-09-24T09:00:00Z", "2026-09-24T09:01:00Z"),
      a("p1", "pending", "2026-09-24T10:01:00Z"),
      a("d2", "timeout", "2026-09-24T09:30:00Z", "2026-09-24T09:40:00Z"),
    ]);
    expect(pending.map((x) => x.approval_id)).toEqual(["p1", "p2"]);
    expect(recent.map((x) => x.approval_id)).toEqual(["d2", "d1"]);
  });
});

describe("live source auth", () => {
  class FakeSocket {
    static last: FakeSocket;
    sent: string[] = [];
    onopen?: () => void;
    onclose?: (ev: { code: number }) => void;
    onmessage?: (ev: { data: string }) => void;
    constructor(readonly url: string) {
      FakeSocket.last = this;
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
  }

  it("sends the token as the first message and stops retrying on 4401", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const states: string[] = [];
    const { source } = liveSource("http://c:4800", "default", () => "tok");
    const stop = source({ send: () => {}, setConnection: (c) => states.push(c) });
    const first = FakeSocket.last;
    first.onopen?.();
    expect(first.sent.map((m) => JSON.parse(m))).toEqual([{ type: "auth", token: "tok" }]);
    expect(states).toEqual(["connecting"]); // not "live" until the collector sends something
    first.onclose?.({ code: 4401 });
    expect(states.at(-1)).toBe("unauthorized");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(first); // no reconnect loop without a new token
    stop();
  });

  it("goes live on the first message, and retry leaves exactly one socket", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    const states: string[] = [];
    const { source, retry } = liveSource("http://c:4800", "default");
    const stop = source({ send: () => {}, setConnection: (c) => states.push(c) });
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: "runs", runs: [] }) });
    expect(states.at(-1)).toBe("live");
    const old = FakeSocket.last;
    retry();
    const fresh = FakeSocket.last;
    expect(fresh).not.toBe(old);
    old.onclose?.({ code: 1000 }); // detached: must not schedule another reconnect
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(fresh);
    stop();
  });

  it("sends nothing without a token", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { source } = liveSource("http://c:4800", "default");
    const stop = source({ send: () => {}, setConnection: () => {} });
    FakeSocket.last.onopen?.();
    expect(FakeSocket.last.sent).toEqual([]);
    stop();
  });
});
