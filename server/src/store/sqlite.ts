import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentSpaceEvent,
  AgentState,
  AgentStatus,
  ApprovalContext,
  ApprovalState,
  ApprovalStatus,
  RunControl,
  RunState,
  RunStatus,
  StoredEvent,
} from "@agentspace/spec-types";
import { computeStats, type ErrorRow, type LlmRow, type StatsWindow } from "./stats.js";
import type { BaselineRows } from "../detect/baseline.js";
import type { ControlAction, ControlOptions, ControlOutcome, InsertResult, ResolveOutcome, Store } from "./types.js";

/**
 * SQLite store (the default). better-sqlite3 is synchronous; the async methods simply return
 * resolved promises so the collector code is identical for Postgres.
 */
export class SqliteStore implements Store {
  readonly db: Database.Database;
  private s: ReturnType<SqliteStore["prepare"]>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.s = this.prepare();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        id          TEXT NOT NULL,
        workspace   TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        agent_id    TEXT,
        type        TEXT NOT NULL,
        ts          TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        body        TEXT NOT NULL,
        UNIQUE (workspace, id)
      );
      CREATE INDEX IF NOT EXISTS events_ws_seq ON events (workspace, seq);
      CREATE INDEX IF NOT EXISTS events_run ON events (workspace, run_id, seq);
      CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
      CREATE INDEX IF NOT EXISTS events_type_ts ON events (workspace, type, ts);

      CREATE TABLE IF NOT EXISTS agents (
        workspace      TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        team_id        TEXT,
        name           TEXT NOT NULL,
        role           TEXT,
        framework      TEXT,
        status         TEXT NOT NULL DEFAULT 'idle',
        status_detail  TEXT,
        last_summary   TEXT,
        last_event_at  TEXT,
        current_run_id TEXT,
        tokens_in      INTEGER NOT NULL DEFAULT 0,
        tokens_out     INTEGER NOT NULL DEFAULT 0,
        cost_usd       REAL NOT NULL DEFAULT 0,
        cost_estimated_usd REAL NOT NULL DEFAULT 0,
        unpriced_calls INTEGER NOT NULL DEFAULT 0,
        findings    INTEGER NOT NULL DEFAULT 0,
        model          TEXT,
        PRIMARY KEY (workspace, agent_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        workspace   TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        name        TEXT,
        framework   TEXT,
        status      TEXT NOT NULL DEFAULT 'running',
        started_at  TEXT,
        finished_at TEXT,
        duration_ms REAL,
        event_count INTEGER NOT NULL DEFAULT 0,
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL NOT NULL DEFAULT 0,
        cost_estimated_usd REAL NOT NULL DEFAULT 0,
        unpriced_calls INTEGER NOT NULL DEFAULT 0,
        findings    INTEGER NOT NULL DEFAULT 0,
        control     TEXT NOT NULL DEFAULT 'running',
        control_by  TEXT,
        control_reason TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (workspace, run_id)
      );
      CREATE INDEX IF NOT EXISTS runs_recent ON runs (workspace, updated_at DESC);

      CREATE TABLE IF NOT EXISTS approvals (
        workspace   TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        run_id      TEXT NOT NULL,
        agent_id    TEXT,
        team_id     TEXT,
        reason      TEXT NOT NULL,
        payload     TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        comment     TEXT,
        resolved_by TEXT,
        created_at  TEXT NOT NULL,
        expires_at  TEXT,
        resolved_at TEXT,
        policy      TEXT,
        context     TEXT,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (workspace, approval_id)
      );
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals (workspace, status, created_at);
      CREATE INDEX IF NOT EXISTS approvals_run ON approvals (workspace, run_id);
    `);
    // Databases created before run controls (4a), cost sources (D-037), findings (D-044) and policy (D-045).
    const addColumn = (table: string, column: string, type: string) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    addColumn("runs", "control", "TEXT NOT NULL DEFAULT 'running'");
    for (const table of ["agents", "runs"]) {
      addColumn(table, "cost_estimated_usd", "REAL NOT NULL DEFAULT 0");
      addColumn(table, "unpriced_calls", "INTEGER NOT NULL DEFAULT 0");
      addColumn(table, "findings", "INTEGER NOT NULL DEFAULT 0");
    }
    addColumn("runs", "control_by", "TEXT");
    addColumn("runs", "control_reason", "TEXT");
    addColumn("approvals", "policy", "TEXT");
    addColumn("approvals", "context", "TEXT");
  }

  private prepare() {
    const db = this.db;
    return {
      insertEvent: db.prepare(
        `INSERT OR IGNORE INTO events (id, workspace, run_id, agent_id, type, ts, received_at, body)
         VALUES (@id, @workspace, @run_id, @agent_id, @type, @ts, @received_at, @body)`,
      ),
      ensureAgent: db.prepare(
        `INSERT INTO agents (workspace, agent_id, team_id, name) VALUES (@workspace, @agent_id, @team_id, @agent_id)
         ON CONFLICT (workspace, agent_id) DO NOTHING`,
      ),
      registerAgent: db.prepare(
        `UPDATE agents SET team_id = @team_id, name = @name, role = @role, framework = @framework
         WHERE workspace = @workspace AND agent_id = @agent_id`,
      ),
      touchAgent: db.prepare(
        `UPDATE agents SET last_event_at = @ts, current_run_id = @run_id, team_id = COALESCE(@team_id, team_id),
           findings = CASE WHEN current_run_id IS @run_id THEN findings ELSE 0 END,
           last_summary = COALESCE(@summary, last_summary), model = COALESCE(@model, model),
           tokens_in = tokens_in + @tokens_in, tokens_out = tokens_out + @tokens_out, cost_usd = cost_usd + @cost_usd,
           cost_estimated_usd = cost_estimated_usd + @cost_estimated_usd, unpriced_calls = unpriced_calls + @unpriced_calls
         WHERE workspace = @workspace AND agent_id = @agent_id`,
      ),
      addAgentFinding: db.prepare(
        `UPDATE agents SET findings = findings + 1 WHERE workspace = @workspace AND agent_id = @agent_id AND current_run_id IS @run_id`,
      ),
      setAgentStatus: db.prepare(`UPDATE agents SET status = @status, status_detail = @detail WHERE workspace = @workspace AND agent_id = @agent_id`),
      ensureRun: db.prepare(
        `INSERT INTO runs (workspace, run_id, started_at, updated_at, event_count, tokens_in, tokens_out, cost_usd, cost_estimated_usd, unpriced_calls, findings)
         VALUES (@workspace, @run_id, @ts, @now, 1, @tokens_in, @tokens_out, @cost_usd, @cost_estimated_usd, @unpriced_calls, @findings)
         ON CONFLICT (workspace, run_id) DO UPDATE SET event_count = event_count + 1, updated_at = @now,
           tokens_in = tokens_in + @tokens_in, tokens_out = tokens_out + @tokens_out, cost_usd = cost_usd + @cost_usd,
           cost_estimated_usd = cost_estimated_usd + @cost_estimated_usd, unpriced_calls = unpriced_calls + @unpriced_calls,
           findings = findings + @findings`,
      ),
      startRun: db.prepare(
        `UPDATE runs SET name = COALESCE(@name, name), framework = COALESCE(@framework, framework), started_at = @ts, status = 'running'
         WHERE workspace = @workspace AND run_id = @run_id`,
      ),
      finishRun: db.prepare(`UPDATE runs SET status = @status, finished_at = @ts, duration_ms = @duration_ms WHERE workspace = @workspace AND run_id = @run_id`),
      controlRun: db.prepare(
        `UPDATE runs SET control = @control, control_by = @by, control_reason = @reason
         WHERE workspace = @workspace AND run_id = @run_id AND control != 'cancelled'`,
      ),
      requestApproval: db.prepare(
        `INSERT OR IGNORE INTO approvals (workspace, approval_id, run_id, agent_id, team_id, reason, payload, policy, created_at, expires_at, updated_at)
         VALUES (@workspace, @approval_id, @run_id, @agent_id, @team_id, @reason, @payload, @policy, @created_at, @expires_at, @now)`,
      ),
      setApprovalContext: db.prepare(`UPDATE approvals SET context = @context, updated_at = @now WHERE workspace = @workspace AND approval_id = @approval_id`),
      resolveApproval: db.prepare(
        `UPDATE approvals SET status = @status, comment = @comment, resolved_by = @resolved_by, resolved_at = @ts, updated_at = @now
         WHERE workspace = @workspace AND approval_id = @approval_id AND status = 'pending'`,
      ),
      // Dashboard rows (stats). Missing bounds are '' and '~', which sort before and after any timestamp.
      statsLlm: db.prepare(
        `SELECT run_id, agent_id, ts, json_extract(body, '$.model') AS model,
           json_extract(body, '$.tokens_in') AS tokens_in, json_extract(body, '$.tokens_out') AS tokens_out,
           json_extract(body, '$.cost_usd') AS cost_usd, json_extract(body, '$.cost_source') AS cost_source,
           json_extract(body, '$.data.duration_ms') AS duration_ms
         FROM events WHERE workspace = @ws AND type = 'llm.call' AND ts >= @since AND ts < @until`,
      ),
      statsTools: db.prepare(
        `SELECT json_extract(body, '$.data.tool_name') AS tool_name, json_extract(body, '$.data.ok') AS ok,
           json_extract(body, '$.data.duration_ms') AS duration_ms
         FROM events WHERE workspace = @ws AND type = 'tool.result' AND ts >= @since AND ts < @until`,
      ),
      statsErrors: db.prepare(`SELECT run_id, agent_id FROM events WHERE workspace = @ws AND type = 'error' AND ts >= @since AND ts < @until`),
      statsRuns: db.prepare(`SELECT * FROM runs WHERE workspace = @ws AND started_at >= @since AND started_at < @until`),
      agents: db.prepare(`SELECT * FROM agents WHERE workspace = ? ORDER BY team_id, agent_id`),
      agent: db.prepare(`SELECT * FROM agents WHERE workspace = ? AND agent_id = ?`),
      runs: db.prepare(`SELECT * FROM runs WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?`),
      run: db.prepare(`SELECT * FROM runs WHERE workspace = ? AND run_id = ?`),
      baselineRuns: db.prepare(
        `SELECT run_id, tokens_in + tokens_out AS tokens, cost_usd FROM runs WHERE workspace = ? AND name = ? AND status = 'ok' ORDER BY started_at DESC LIMIT ?`,
      ),
      runEvents: db.prepare(`SELECT seq, body FROM events WHERE workspace = ? AND run_id = ? AND seq > ? ORDER BY seq LIMIT ?`),
      recentEvents: db.prepare(`SELECT seq, body FROM (SELECT seq, body FROM events WHERE workspace = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`),
      workspaces: db.prepare(`SELECT workspace, COUNT(*) AS agents FROM agents GROUP BY workspace ORDER BY workspace`),
      approvalsAll: db.prepare(`SELECT * FROM approvals WHERE workspace = ? ORDER BY created_at DESC LIMIT ?`),
      approvalsBy: db.prepare(`SELECT * FROM approvals WHERE workspace = ? AND status = ? ORDER BY created_at DESC LIMIT ?`),
      approvalsOfRun: db.prepare(`SELECT * FROM approvals WHERE workspace = ? AND run_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?`),
      approval: db.prepare(`SELECT * FROM approvals WHERE workspace = ? AND approval_id = ?`),
      expired: db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`),
    };
  }

  // ---------------- writes ----------------

  async insert(events: AgentSpaceEvent[]): Promise<InsertResult> {
    return this.db.transaction(() => this.insertSync(events))();
  }

  /** Must run inside a transaction. */
  private insertSync(events: AgentSpaceEvent[]): InsertResult {
    const now = Date.now();
    const inserted: StoredEvent[] = [];
    const touchedAgents = new Set<string>();
    const touchedRuns = new Set<string>();
    const touchedApprovals = new Set<string>();
    for (const ev of events) {
      const res = this.s.insertEvent.run({
        id: ev.id,
        workspace: ev.workspace,
        run_id: ev.run_id,
        agent_id: ev.agent_id,
        type: ev.type,
        ts: ev.ts,
        received_at: now,
        body: JSON.stringify(ev),
      });
      if (res.changes === 0) continue; // duplicate id
      inserted.push({ ...ev, seq: Number(res.lastInsertRowid) });
      this.project(ev, now);
      if (ev.agent_id) touchedAgents.add(key(ev.workspace, ev.agent_id));
      touchedRuns.add(key(ev.workspace, ev.run_id));
      if (ev.type === "approval.requested" || ev.type === "approval.resolved") touchedApprovals.add(key(ev.workspace, ev.data.approval_id));
    }
    return {
      inserted,
      duplicates: events.length - inserted.length,
      agents: [...touchedAgents].map((k) => rowToAgent(this.s.agent.get(...split(k)) as AgentRow)),
      runs: [...touchedRuns].map((k) => rowToRun(this.s.run.get(...split(k)) as RunRow)),
      approvals: [...touchedApprovals].map((k) => this.s.approval.get(...split(k)) as ApprovalRow | undefined).filter((r) => r !== undefined).map(rowToApproval),
    };
  }

  private project(ev: AgentSpaceEvent, now: number): void {
    const s = this.s;
    const usage = usageOf(ev);
    const run = { workspace: ev.workspace, run_id: ev.run_id };
    s.ensureRun.run({ ...run, ts: ev.ts, now, ...usage, findings: ev.type === "anomaly.detected" ? 1 : 0 });

    switch (ev.type) {
      case "run.started":
        s.startRun.run({ ...run, ts: ev.ts, name: ev.data.name ?? null, framework: ev.data.framework ?? null });
        break;
      case "run.finished":
        s.finishRun.run({ ...run, ts: ev.ts, status: ev.data.status, duration_ms: ev.data.duration_ms ?? null });
        break;
      case "run.control":
        s.controlRun.run({ ...run, control: controlAfter(ev.data.action), by: ev.data.by ?? null, reason: ev.data.reason ?? null });
        break;
      case "approval.requested": {
        const expires = ev.data.timeout_s !== undefined ? new Date(Date.parse(ev.ts) + ev.data.timeout_s * 1000).toISOString() : null;
        s.requestApproval.run({
          ...run,
          approval_id: ev.data.approval_id,
          agent_id: ev.agent_id,
          team_id: ev.team_id,
          reason: ev.data.reason,
          payload: ev.data.payload === undefined ? null : JSON.stringify(ev.data.payload),
          policy: ev.data.policy ? JSON.stringify(ev.data.policy) : null,
          created_at: ev.ts,
          expires_at: expires,
          now,
        });
        break;
      }
      case "approval.resolved":
        s.resolveApproval.run({
          workspace: ev.workspace,
          approval_id: ev.data.approval_id,
          status: ev.data.decision,
          comment: ev.data.comment ?? null,
          resolved_by: ev.data.resolved_by ?? null,
          ts: ev.ts,
          now,
        });
        break;
    }

    if (!ev.agent_id) return;
    const agent = { workspace: ev.workspace, agent_id: ev.agent_id };
    s.ensureAgent.run({ ...agent, team_id: ev.team_id });
    // A finding is about the agent, not something it did: it only counts toward its current run.
    if (ev.type === "anomaly.detected") {
      s.addAgentFinding.run({ ...agent, run_id: ev.run_id });
      return;
    }
    if (ev.type === "agent.registered") {
      s.registerAgent.run({ ...agent, team_id: ev.team_id, name: ev.data.name, role: ev.data.role ?? null, framework: ev.data.framework ?? null });
    } else if (ev.type === "agent.status") {
      s.setAgentStatus.run({ ...agent, status: ev.data.status, detail: ev.data.detail ?? null });
    }
    s.touchAgent.run({
      ...agent,
      ts: ev.ts,
      run_id: ev.run_id,
      team_id: ev.team_id,
      summary: ev.summary ?? null,
      model: ev.type === "llm.call" ? (ev.model ?? null) : null,
      ...usage,
    });
  }

  async resolveApproval(
    workspace: string,
    approvalId: string,
    decision: "approved" | "rejected" | "timeout",
    opts: { comment?: string; by?: string; now?: Date },
  ): Promise<ResolveOutcome> {
    return this.db.transaction((): ResolveOutcome => {
      const row = this.s.approval.get(workspace, approvalId) as ApprovalRow | undefined;
      if (!row) return { result: "not_found" };
      if (row.status !== "pending") return { result: "conflict", approval: rowToApproval(row) };
      const now = opts.now ?? new Date();
      // A decision that arrives after the deadline doesn't count: the approval timed out.
      const expired = row.expires_at !== null && Date.parse(row.expires_at) < now.getTime();
      const final = expired ? "timeout" : decision;
      const changes = this.insertSync([resolvedEvent(row, final, final === decision ? opts : { by: "system" }, now)]);
      const approval = rowToApproval(this.s.approval.get(workspace, approvalId) as ApprovalRow);
      return expired && decision !== "timeout" ? { result: "conflict", approval } : { result: "resolved", approval, changes };
    })();
  }

  async setControl(workspace: string, runId: string, action: ControlAction, opts: ControlOptions): Promise<ControlOutcome> {
    return this.db.transaction((): ControlOutcome => {
      const row = this.s.run.get(workspace, runId) as RunRow | undefined;
      if (!row) return { result: "not_found" };
      const current = row.control as RunControl;
      if (!controlAllowed(current, action)) return { result: "conflict", run: rowToRun(row) };
      const changes = this.insertSync([controlEvent(workspace, runId, action, opts.by, opts.now ?? new Date(), opts.reason, opts.findingId)]);
      return { result: "ok", run: rowToRun(this.s.run.get(workspace, runId) as RunRow), changes };
    })();
  }

  // ---------------- reads ----------------

  async agents(workspace: string) {
    return (this.s.agents.all(workspace) as AgentRow[]).map(rowToAgent);
  }
  async runs(workspace: string, limit = 50) {
    return (this.s.runs.all(workspace, limit) as RunRow[]).map(rowToRun);
  }
  async stats(workspace: string, window: StatsWindow) {
    const p = { ws: workspace, since: window.since ?? "", until: window.until ?? "~" };
    const s = this.s;
    const tools = s.statsTools.all(p) as { tool_name: string; ok: number; duration_ms: number | null }[];
    return computeStats(workspace, window, {
      llm: s.statsLlm.all(p) as LlmRow[],
      tools: tools.map((t) => ({ ...t, ok: t.ok === 1 })),
      errors: s.statsErrors.all(p) as ErrorRow[],
      runs: (s.statsRuns.all(p) as RunRow[]).map(rowToRun),
      agents: (s.agents.all(workspace) as AgentRow[]).map(rowToAgent),
    });
  }
  async baselineRows(workspace: string, name: string, limit: number): Promise<BaselineRows> {
    const runs = this.s.baselineRuns.all(workspace, name, limit) as BaselineRows["runs"];
    if (!runs.length) return { runs, agents: [] };
    const agents = this.db
      .prepare(
        `SELECT run_id, agent_id, SUM(type = 'tool.call') AS tool_calls FROM events
         WHERE workspace = ? AND agent_id IS NOT NULL AND run_id IN (${runs.map(() => "?").join(",")})
         GROUP BY run_id, agent_id`,
      )
      .all(workspace, ...runs.map((r) => r.run_id)) as BaselineRows["agents"];
    return { runs, agents };
  }

  async escalatedRuns(workspace: string, runIds: string[]) {
    if (!runIds.length) return [];
    const rows = this.db
      .prepare(`SELECT run_id FROM runs WHERE workspace = ? AND findings > 0 AND run_id IN (${runIds.map(() => "?").join(",")})`)
      .all(workspace, ...runIds) as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  async setApprovalContext(workspace: string, approvalId: string, context: ApprovalContext) {
    this.s.setApprovalContext.run({ workspace, approval_id: approvalId, context: JSON.stringify(context), now: Date.now() });
    const row = this.s.approval.get(workspace, approvalId) as ApprovalRow | undefined;
    return row && rowToApproval(row);
  }

  async run(workspace: string, runId: string) {
    const row = this.s.run.get(workspace, runId) as RunRow | undefined;
    return row && rowToRun(row);
  }
  async runEvents(workspace: string, runId: string, after = 0, limit = 1000) {
    return (this.s.runEvents.all(workspace, runId, after, limit) as EventRow[]).map(rowToEvent);
  }
  async recentEvents(workspace: string, limit = 200) {
    return (this.s.recentEvents.all(workspace, limit) as EventRow[]).map(rowToEvent);
  }
  async workspaces() {
    return this.s.workspaces.all() as { workspace: string; agents: number }[];
  }
  async approvals(workspace: string, status?: ApprovalStatus, limit = 100, runId?: string) {
    const rows = runId
      ? this.s.approvalsOfRun.all(workspace, runId, status ?? null, status ?? null, limit)
      : status
        ? this.s.approvalsBy.all(workspace, status, limit)
        : this.s.approvalsAll.all(workspace, limit);
    return (rows as ApprovalRow[]).map(rowToApproval);
  }
  async approval(workspace: string, approvalId: string) {
    const row = this.s.approval.get(workspace, approvalId) as ApprovalRow | undefined;
    return row && rowToApproval(row);
  }
  async expiredApprovals(now = new Date()) {
    return (this.s.expired.all(now.toISOString()) as ApprovalRow[]).map(rowToApproval);
  }
  async controls(workspace: string, runIds: string[]) {
    const out: Record<string, RunControl> = {};
    if (!runIds.length) return out;
    const rows = this.db
      .prepare(`SELECT run_id, control FROM runs WHERE workspace = ? AND control != 'running' AND run_id IN (${runIds.map(() => "?").join(",")})`)
      .all(workspace, ...runIds) as { run_id: string; control: RunControl }[];
    for (const r of rows) out[r.run_id] = r.control;
    return out;
  }

  async prune(days: number, now = new Date()) {
    const cutoff = now.getTime() - days * 86_400_000;
    const { changes } = this.db.prepare(`DELETE FROM events WHERE received_at < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM runs WHERE updated_at < ? AND status != 'running'`).run(cutoff);
    this.db.prepare(`DELETE FROM approvals WHERE updated_at < ? AND status != 'pending'`).run(cutoff);
    return changes;
  }

  async close() {
    this.db.close();
  }
}

// ---------------- shared helpers (also used by the Postgres store) ----------------

export function controlAfter(action: ControlAction): RunControl {
  return action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
}

/** Which operator actions make sense from which state. "cancelled" is final. */
export function controlAllowed(current: RunControl, action: ControlAction): boolean {
  if (current === "cancelled") return false;
  if (action === "pause") return current === "running";
  if (action === "resume") return current === "paused";
  return true; // cancel from running or paused
}

export function resolvedEvent(
  a: { workspace: string; approval_id: string; run_id: string; agent_id: string | null; team_id: string | null },
  decision: "approved" | "rejected" | "timeout",
  opts: { comment?: string; by?: string },
  now: Date,
): AgentSpaceEvent {
  return {
    spec_version: "0.1",
    // Deterministic: an approval can only ever be resolved once.
    id: `approval-resolved-${a.approval_id}`.slice(0, 128),
    type: "approval.resolved",
    ts: now.toISOString(),
    workspace: a.workspace,
    run_id: a.run_id,
    agent_id: a.agent_id,
    team_id: a.team_id,
    parent_id: null,
    summary: `${decision}${opts.by ? ` by ${opts.by}` : ""}`.slice(0, 500),
    data: {
      approval_id: a.approval_id,
      decision,
      ...(opts.comment ? { comment: opts.comment.slice(0, 2000) } : {}),
      ...(opts.by ? { resolved_by: opts.by.slice(0, 256) } : {}),
    },
  } as AgentSpaceEvent;
}

export function controlEvent(
  workspace: string,
  runId: string,
  action: ControlAction,
  by: string | undefined,
  now: Date,
  reason?: string,
  findingId?: string,
): AgentSpaceEvent {
  const verb = { pause: "Paused", resume: "Resumed", cancel: "Cancelled" }[action];
  return {
    spec_version: "0.1",
    id: `control-${randomUUID()}`,
    type: "run.control",
    ts: now.toISOString(),
    workspace,
    run_id: runId,
    agent_id: null,
    team_id: null,
    parent_id: null,
    summary: `${verb}${by ? ` by ${by}` : ""}`.slice(0, 500),
    data: { action, ...(by ? { by: by.slice(0, 256) } : {}), ...(reason ? { reason: reason.slice(0, 500) } : {}), ...(findingId ? { finding_id: findingId } : {}) },
  } as AgentSpaceEvent;
}

// ---------------- projection rules ----------------

/**
 * What an event adds to its agent's and run's totals. Only `llm.call` counts (the totals rule).
 * Must match `usageOf` in web/lib/projector.ts (shared fixture: projection.expected.json).
 */
export function usageOf(ev: AgentSpaceEvent) {
  if (ev.type !== "llm.call") return { tokens_in: 0, tokens_out: 0, cost_usd: 0, cost_estimated_usd: 0, unpriced_calls: 0 };
  const tokensIn = ev.tokens_in ?? 0;
  const tokensOut = ev.tokens_out ?? 0;
  const cost = ev.cost_usd ?? 0;
  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: cost,
    cost_estimated_usd: ev.cost_source === "estimated" ? cost : 0,
    // Tokens but no cost from anyone: the model isn't in the price table.
    unpriced_calls: tokensIn + tokensOut > 0 && ev.cost_usd === undefined && ev.cost_source === undefined ? 1 : 0,
  };
}

// ---------------- row mapping ----------------

interface EventRow {
  seq: number;
  body: string;
}
type AgentRow = Omit<AgentState, "status"> & { status: string };
type RunRow = Omit<RunState, "status" | "control"> & { status: string; control: string; updated_at?: number };
interface ApprovalRow {
  workspace: string;
  approval_id: string;
  run_id: string;
  agent_id: string | null;
  team_id: string | null;
  reason: string;
  payload: string | null;
  policy: string | null;
  context: string | null;
  status: string;
  comment: string | null;
  resolved_by: string | null;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
}

function key(a: string, b: string): string {
  return `${a}\u0000${b}`;
}
function split(k: string): [string, string] {
  return k.split("\u0000") as [string, string];
}
export function rowToEvent(row: EventRow): StoredEvent {
  return { ...(JSON.parse(row.body) as AgentSpaceEvent), seq: Number(row.seq) };
}
export function rowToAgent(row: AgentRow): AgentState {
  return { ...row, status: row.status as AgentStatus };
}
export function rowToRun(row: RunRow): RunState {
  const { updated_at: _u, ...rest } = row;
  return { ...rest, status: row.status as RunStatus, control: row.control as RunControl };
}
export function rowToApproval(row: ApprovalRow): ApprovalState {
  const { updated_at: _u, ...rest } = row as ApprovalRow & { updated_at?: number };
  return {
    ...rest,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
    policy: row.policy ? (JSON.parse(row.policy) as ApprovalState["policy"]) : null,
    context: row.context ? (JSON.parse(row.context) as ApprovalState["context"]) : null,
    status: row.status as ApprovalStatus,
  };
}
