import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentSpaceEvent, StoredEvent } from "@agentspace/spec-types";
import type { Store } from "../store/types.js";
import { computeBaseline } from "./baseline.js";
import { DEFAULT_CONFIG, DETECTORS } from "./detectors.js";
import type { Baseline, DetectorConfig, Finding, RunContext } from "./types.js";

const MAX_RUNS = 2000;
const MAX_REBUILD_EVENTS = 50_000;
const BASELINE_RUNS = 50;
const BASELINE_TTL_MS = 60_000;

interface RunMemory {
  ctx: RunContext;
  checkers: ((e: AgentSpaceEvent) => Finding[])[];
  nameLooked: boolean;
  name: string | null;
  sent: Set<string>;
}

type Logger = { warn: (obj: object, msg: string) => void };

/**
 * Runs the detectors over newly stored events and returns `anomaly.detected` events to store
 * (D-044). Per-run state is kept in memory (least recently used dropped first). A run it hasn't
 * seen, or has forgotten, is rebuilt from the store; finding ids are deterministic, so a rebuild
 * never produces a duplicate.
 */
export class DetectorEngine {
  private runs = new Map<string, RunMemory>();
  private baselines = new Map<string, { at: number; value: Promise<Baseline | null> }>();

  constructor(
    private readonly db: Store,
    private readonly config: DetectorConfig | null,
    private readonly log: Logger = { warn: () => undefined },
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  async observe(inserted: StoredEvent[]): Promise<AgentSpaceEvent[]> {
    if (!this.config) return [];
    const byRun = new Map<string, StoredEvent[]>();
    for (const e of inserted) {
      if (e.type === "anomaly.detected") continue;
      const k = `${e.workspace}\u0000${e.run_id}`;
      byRun.set(k, [...(byRun.get(k) ?? []), e]);
    }
    const out: AgentSpaceEvent[] = [];
    for (const [k, events] of byRun) {
      try {
        out.push(...(await this.observeRun(k, events)));
      } catch (err) {
        this.log.warn({ err, run: events[0]?.run_id }, "detectors failed for a run");
      }
    }
    return out;
  }

  private async observeRun(key: string, batch: StoredEvent[]): Promise<AgentSpaceEvent[]> {
    const { workspace, run_id } = batch[0]!;
    let mem = this.runs.get(key);
    let events: AgentSpaceEvent[] = batch;
    if (mem) {
      this.runs.delete(key); // re-insert: most recently used last
    } else {
      mem = this.newRun(workspace, run_id);
      // The run started before this collector saw it (restart, or forgotten): replay what's stored.
      const stored = await this.db.runEvents(workspace, run_id, 0, MAX_REBUILD_EVENTS);
      if (stored.length > batch.length) events = stored.filter((e) => e.type !== "anomaly.detected");
    }
    this.runs.set(key, mem);
    if (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);

    for (const e of events) if (e.type === "run.started" && e.data.name) mem.name = e.data.name;
    if (!mem.name && !mem.nameLooked) {
      mem.nameLooked = true;
      mem.name = (await this.db.run(workspace, run_id))?.name ?? null;
    }
    if (mem.name && !mem.ctx.baseline) mem.ctx.baseline = await this.baseline(workspace, mem.name);

    const out: AgentSpaceEvent[] = [];
    for (const e of events) {
      // A newly finished good run changes its workflow's baseline: don't keep serving the old one.
      if (e.type === "run.finished" && e.data.status === "ok" && mem.name) this.baselines.delete(`${workspace}\u0000${mem.name}`);
      for (const check of mem.checkers) {
        for (const f of check(e)) {
          const ev = toEvent(f, workspace, run_id);
          if (mem.sent.has(ev.id)) continue;
          mem.sent.add(ev.id);
          out.push(ev);
        }
      }
    }
    return out;
  }

  private newRun(workspace: string, runId: string): RunMemory {
    const ctx: RunContext = { workspace, runId, baseline: null };
    const cfg = this.config!;
    const checkers = DETECTORS.filter((d) => cfg[d.id as keyof DetectorConfig].enabled).map((d) =>
      (d.create as (c: RunContext, x: unknown) => (e: AgentSpaceEvent) => Finding[])(ctx, cfg[d.id as keyof DetectorConfig]),
    );
    return { ctx, checkers, nameLooked: false, name: null, sent: new Set() };
  }

  /** The workflow's baseline (cached), also used for approval evidence (D-045). */
  baselineFor(workspace: string, name: string): Promise<Baseline | null> {
    return this.baseline(workspace, name);
  }

  private baseline(workspace: string, name: string): Promise<Baseline | null> {
    const k = `${workspace}\u0000${name}`;
    const hit = this.baselines.get(k);
    if (hit && this.now() - hit.at < BASELINE_TTL_MS) return hit.value;
    const value = this.db.baselineRows(workspace, name, BASELINE_RUNS).then(
      (rows) => (rows.runs.length ? computeBaseline(rows) : null),
      (err: unknown) => {
        this.log.warn({ err }, "baseline query failed");
        return null;
      },
    );
    this.baselines.set(k, { at: this.now(), value });
    if (this.baselines.size > MAX_RUNS) this.baselines.delete(this.baselines.keys().next().value!);
    return value;
  }
}

/** The finding as an event: placed at the trigger's agent, step and time. */
export function toEvent(f: Finding, workspace: string, runId: string): AgentSpaceEvent {
  const id = `anom-${createHash("sha256").update(`${workspace}\u0000${runId}\u0000${f.detector}\u0000${f.key}`).digest("hex").slice(0, 32)}`;
  return {
    spec_version: "0.1",
    id,
    type: "anomaly.detected",
    ts: f.trigger.ts,
    workspace,
    run_id: runId,
    agent_id: f.trigger.agent_id,
    team_id: f.trigger.team_id,
    parent_id: f.trigger.parent_id,
    summary: f.message,
    data: { detector: f.detector, severity: f.severity, message: f.message, evidence: f.evidence, subject_ids: f.subjectIds },
  };
}

/**
 * `AGENTSPACE_DETECTORS=off` disables detection. `AGENTSPACE_DETECTORS_FILE` points at JSON that
 * overrides the defaults per detector: `false` turns one off, an object changes its thresholds,
 * e.g. `{"failure_loop": {"min_count": 5}, "usage_outlier": false}`.
 */
export function loadDetectorConfig(env: { AGENTSPACE_DETECTORS?: string; AGENTSPACE_DETECTORS_FILE?: string }): DetectorConfig | null {
  if (["off", "0", "false", "no"].includes((env.AGENTSPACE_DETECTORS ?? "").toLowerCase())) return null;
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (!env.AGENTSPACE_DETECTORS_FILE) return cfg;
  const raw = JSON.parse(readFileSync(env.AGENTSPACE_DETECTORS_FILE, "utf8")) as Record<string, unknown>;
  for (const [id, v] of Object.entries(raw)) {
    if (!(id in cfg)) throw new Error(`AGENTSPACE_DETECTORS_FILE: unknown detector "${id}" (known: ${Object.keys(cfg).join(", ")})`);
    const target = cfg[id as keyof DetectorConfig] as Record<string, unknown>;
    if (v === false) target.enabled = false;
    else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (!(k in target) || typeof val !== typeof target[k]) throw new Error(`AGENTSPACE_DETECTORS_FILE: bad setting ${id}.${k}`);
        target[k] = val;
      }
    }
  }
  return cfg;
}
