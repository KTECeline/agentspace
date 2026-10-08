import type { AgentSpaceEvent, RunState } from "@agentspace/spec-types";
import { fetchRunEvents, fetchRuns } from "./collector";
import { Projector } from "./projector";
import { RECORDINGS, type RecordingInfo } from "./recordings";
import type { Recording } from "./sources/recorded";

/**
 * Where /compare gets its runs: a collector, or the recordings bundled with the web app
 * (/demo/compare, which must never call a collector: D-041). A plain descriptor, so a server
 * page can pass it to the client view.
 */
export type CompareSourceSpec = { kind: "collector"; url: string; workspace: string } | { kind: "recordings" };

export interface CompareSource {
  /** Changes when the data behind it does (effects key on it). */
  key: string;
  /** The header chip. */
  label: string;
  /** Set for a collector: tokens, error hints and the office's collector apply. */
  collector: { url: string; workspace: string } | null;
  runs(token: string | null): Promise<RunState[]>;
  events(runId: string, token: string | null): Promise<{ events: AgentSpaceEvent[]; truncated: boolean }>;
  replayHref(runId: string, eventId?: string): string;
}

export function compareSource(spec: CompareSourceSpec): CompareSource {
  return spec.kind === "collector" ? collectorSource(spec.url, spec.workspace) : recordingSource(RECORDINGS, (file) => fetchRecording(file));
}

function collectorSource(url: string, workspace: string): CompareSource {
  return {
    key: `collector:${url}:${workspace}`,
    label: `workspace: ${workspace}`,
    collector: { url, workspace },
    runs: (token) => fetchRuns(url, workspace, token),
    events: (runId, token) => fetchRunEvents(url, workspace, runId, token),
    replayHref: (run, eventId) => `/replay?${new URLSearchParams({ collector: url, workspace, run, ...(eventId ? { event: eventId } : {}) })}`,
  };
}

/** Runs from bundled recordings: each recording is one run, projected like the collector does. */
export function recordingSource(recordings: RecordingInfo[], load: (file: string) => Promise<Recording>): CompareSource {
  let loaded: Promise<{ info: RecordingInfo; rec: Recording }[]> | null = null;
  const all = () => (loaded ??= Promise.all(recordings.map(async (info) => ({ info, rec: await load(info.file) }))));
  const byRun = async (runId: string) => {
    const hit = (await all()).find((r) => r.rec.run_id === runId);
    if (!hit) throw new Error(`no recording of run ${runId}`);
    return hit;
  };
  // Filled as runs load, so links can be built synchronously afterwards.
  const scenarioOf = new Map<string, string>();
  return {
    key: `recordings:${recordings.map((r) => r.id).join(",")}`,
    label: "recorded runs",
    collector: null,
    async runs() {
      const out: RunState[] = [];
      for (const { info, rec } of await all()) {
        const p = new Projector();
        for (const e of rec.events) p.apply({ ...e, workspace: "demo" });
        const run = p.runList("demo").find((r) => r.run_id === rec.run_id);
        if (!run) continue;
        scenarioOf.set(run.run_id, info.id);
        out.push({ ...run, name: run.name ?? info.label });
      }
      return out.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
    },
    async events(runId) {
      return { events: (await byRun(runId)).rec.events, truncated: false };
    },
    replayHref(runId, eventId) {
      const q = new URLSearchParams({ scenario: scenarioOf.get(runId) ?? "" });
      if (eventId) q.set("event", eventId);
      return `/demo?${q}`;
    },
  };
}

async function fetchRecording(file: string): Promise<Recording> {
  const res = await fetch(file);
  if (!res.ok) throw new Error(`couldn't load ${file} (HTTP ${res.status})`);
  return (await res.json()) as Recording;
}
