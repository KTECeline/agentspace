import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentSpaceEvent,
  AgentState,
  AgentStatus,
  RunState,
  RunStatus,
  StoredEvent,
} from "@agentspace/spec-types";

/**
 * SQLite storage: an append-only event log plus two projections (agents, runs) that are
 * updated in the same transaction as the insert, so they never drift.
 *
 * Totals rule (see spec/README.md): tokens and cost are summed over `llm.call` events only.
 */
export class Store {
  readonly db: Database.Database;
  private stmts: ReturnType<Store["prepare"]>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.stmts = this.prepare();
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
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (workspace, run_id)
      );
      CREATE INDEX IF NOT EXISTS runs_recent ON runs (workspace, updated_at DESC);
    `);
  }

  private prepare() {
    const db = this.db;
    return {
      insertEvent: db.prepare(
        `INSERT OR IGNORE INTO events (id, workspace, run_id, agent_id, type, ts, received_at, body)
         VALUES (@id, @workspace, @run_id, @agent_id, @type, @ts, @received_at, @body)`,
      ),
      ensureAgent: db.prepare(
        `INSERT INTO agents (workspace, agent_id, team_id, name)
         VALUES (@workspace, @agent_id, @team_id, @agent_id)
         ON CONFLICT (workspace, agent_id) DO NOTHING`,
      ),
      registerAgent: db.prepare(
        `UPDATE agents SET team_id = @team_id, name = @name, role = @role, framework = @framework
         WHERE workspace = @workspace AND agent_id = @agent_id`,
      ),
      touchAgent: db.prepare(
        `UPDATE agents SET
           last_event_at  = @ts,
           current_run_id = @run_id,
           team_id        = COALESCE(@team_id, team_id),
           last_summary   = COALESCE(@summary, last_summary),
           model          = COALESCE(@model, model),
           tokens_in      = tokens_in + @tokens_in,
           tokens_out     = tokens_out + @tokens_out,
           cost_usd       = cost_usd + @cost_usd
         WHERE workspace = @workspace AND agent_id = @agent_id`,
      ),
      setAgentStatus: db.prepare(
        `UPDATE agents SET status = @status, status_detail = @detail
         WHERE workspace = @workspace AND agent_id = @agent_id`,
      ),
      ensureRun: db.prepare(
        `INSERT INTO runs (workspace, run_id, started_at, updated_at, event_count,
                           tokens_in, tokens_out, cost_usd)
         VALUES (@workspace, @run_id, @ts, @now, 1, @tokens_in, @tokens_out, @cost_usd)
         ON CONFLICT (workspace, run_id) DO UPDATE SET
           event_count = event_count + 1,
           updated_at  = @now,
           tokens_in   = tokens_in + @tokens_in,
           tokens_out  = tokens_out + @tokens_out,
           cost_usd    = cost_usd + @cost_usd`,
      ),
      startRun: db.prepare(
        `UPDATE runs SET name = COALESCE(@name, name), framework = COALESCE(@framework, framework),
           started_at = @ts, status = 'running'
         WHERE workspace = @workspace AND run_id = @run_id`,
      ),
      finishRun: db.prepare(
        `UPDATE runs SET status = @status, finished_at = @ts, duration_ms = @duration_ms
         WHERE workspace = @workspace AND run_id = @run_id`,
      ),
      agents: db.prepare(`SELECT * FROM agents WHERE workspace = ? ORDER BY team_id, agent_id`),
      agent: db.prepare(`SELECT * FROM agents WHERE workspace = ? AND agent_id = ?`),
      runs: db.prepare(`SELECT * FROM runs WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?`),
      run: db.prepare(`SELECT * FROM runs WHERE workspace = ? AND run_id = ?`),
      runEvents: db.prepare(
        `SELECT seq, body FROM events WHERE workspace = ? AND run_id = ? AND seq > ?
         ORDER BY seq LIMIT ?`,
      ),
      recentEvents: db.prepare(
        `SELECT seq, body FROM (
           SELECT seq, body FROM events WHERE workspace = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`,
      ),
      workspaces: db.prepare(
        `SELECT workspace, COUNT(*) AS agents FROM agents GROUP BY workspace ORDER BY workspace`,
      ),
    };
  }

  /**
   * Insert a batch in one transaction. Returns the newly stored events (duplicates by
   * `id` are skipped) and the agents/runs whose projections changed.
   */
  insert(events: AgentSpaceEvent[]): {
    inserted: StoredEvent[];
    duplicates: number;
    agents: AgentState[];
    runs: RunState[];
  } {
    const s = this.stmts;
    const now = Date.now();
    const inserted: StoredEvent[] = [];
    const touchedAgents = new Set<string>();
    const touchedRuns = new Set<string>();

    this.db.transaction(() => {
      for (const ev of events) {
        const res = s.insertEvent.run({
          id: ev.id,
          workspace: ev.workspace,
          run_id: ev.run_id,
          agent_id: ev.agent_id,
          type: ev.type,
          ts: ev.ts,
          received_at: now,
          body: JSON.stringify(ev),
        });
        if (res.changes === 0) continue; // duplicate
        inserted.push({ ...ev, seq: Number(res.lastInsertRowid) });
        this.project(ev, now);
        if (ev.agent_id) touchedAgents.add(`${ev.workspace}\u0000${ev.agent_id}`);
        touchedRuns.add(`${ev.workspace}\u0000${ev.run_id}`);
      }
    })();

    const agents = [...touchedAgents].map((k) => {
      const [ws, id] = k.split("\u0000") as [string, string];
      return rowToAgent(s.agent.get(ws, id) as AgentRow);
    });
    const runs = [...touchedRuns].map((k) => {
      const [ws, id] = k.split("\u0000") as [string, string];
      return rowToRun(s.run.get(ws, id) as RunRow);
    });
    return { inserted, duplicates: events.length - inserted.length, agents, runs };
  }

  private project(ev: AgentSpaceEvent, now: number): void {
    const s = this.stmts;
    const isLlm = ev.type === "llm.call";
    const usage = {
      tokens_in: isLlm ? (ev.tokens_in ?? 0) : 0,
      tokens_out: isLlm ? (ev.tokens_out ?? 0) : 0,
      cost_usd: isLlm ? (ev.cost_usd ?? 0) : 0,
    };
    const key = { workspace: ev.workspace, run_id: ev.run_id };

    s.ensureRun.run({ ...key, ts: ev.ts, now, ...usage });
    if (ev.type === "run.started") {
      s.startRun.run({ ...key, ts: ev.ts, name: ev.data.name ?? null, framework: ev.data.framework ?? null });
    } else if (ev.type === "run.finished") {
      s.finishRun.run({
        ...key,
        ts: ev.ts,
        status: ev.data.status,
        duration_ms: ev.data.duration_ms ?? null,
      });
    }

    if (!ev.agent_id) return;
    const akey = { workspace: ev.workspace, agent_id: ev.agent_id };
    s.ensureAgent.run({ ...akey, team_id: ev.team_id });
    if (ev.type === "agent.registered") {
      s.registerAgent.run({
        ...akey,
        team_id: ev.team_id,
        name: ev.data.name,
        role: ev.data.role ?? null,
        framework: ev.data.framework ?? null,
      });
    } else if (ev.type === "agent.status") {
      s.setAgentStatus.run({ ...akey, status: ev.data.status, detail: ev.data.detail ?? null });
    }
    s.touchAgent.run({
      ...akey,
      ts: ev.ts,
      run_id: ev.run_id,
      team_id: ev.team_id,
      summary: ev.summary ?? null,
      model: isLlm ? (ev.model ?? null) : null,
      ...usage,
    });
  }

  agents(workspace: string): AgentState[] {
    return (this.stmts.agents.all(workspace) as AgentRow[]).map(rowToAgent);
  }

  runs(workspace: string, limit = 50): RunState[] {
    return (this.stmts.runs.all(workspace, limit) as RunRow[]).map(rowToRun);
  }

  run(workspace: string, runId: string): RunState | undefined {
    const row = this.stmts.run.get(workspace, runId) as RunRow | undefined;
    return row && rowToRun(row);
  }

  runEvents(workspace: string, runId: string, after = 0, limit = 1000): StoredEvent[] {
    return (this.stmts.runEvents.all(workspace, runId, after, limit) as EventRow[]).map(rowToEvent);
  }

  recentEvents(workspace: string, limit = 200): StoredEvent[] {
    return (this.stmts.recentEvents.all(workspace, limit) as EventRow[]).map(rowToEvent);
  }

  workspaces(): { workspace: string; agents: number }[] {
    return this.stmts.workspaces.all() as { workspace: string; agents: number }[];
  }

  /** Delete events (and finished runs) older than `days`. Agents are kept. */
  prune(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    const { changes } = this.db.prepare(`DELETE FROM events WHERE received_at < ?`).run(cutoff);
    this.db.prepare(`DELETE FROM runs WHERE updated_at < ? AND status != 'running'`).run(cutoff);
    return changes;
  }

  close(): void {
    this.db.close();
  }
}

// ---- row mapping ----

interface EventRow {
  seq: number;
  body: string;
}
type AgentRow = Omit<AgentState, "status"> & { status: string };
type RunRow = Omit<RunState, "status"> & { status: string };

function rowToEvent(row: EventRow): StoredEvent {
  return { ...(JSON.parse(row.body) as AgentSpaceEvent), seq: row.seq };
}

function rowToAgent(row: AgentRow): AgentState {
  return { ...row, status: row.status as AgentStatus };
}

function rowToRun(row: RunRow): RunState {
  const { updated_at: _u, ...rest } = row as RunRow & { updated_at?: number };
  return { ...rest, status: row.status as RunStatus };
}
