"use client";

import { useEffect, useState } from "react";
import { Loader2, Pause, Play, Square } from "lucide-react";
import type { RunState } from "@agentspace/spec-types";
import { actionError, allowedActions, controlRun, type ControlAction } from "@/lib/collector";
import { useCanOperate, useOffice } from "@/lib/store";

const LABEL: Record<ControlAction, string> = { pause: "Pause", resume: "Resume", cancel: "Cancel run" };
const ICON = { pause: Pause, resume: Play, cancel: Square };

/** Pause / resume / cancel for a run. Cancel asks for a second click, since it can't be undone. */
export function RunControls({ run }: { run: RunState }) {
  const canOperate = useCanOperate();
  const collector = useOffice((s) => s.collector);
  const token = useOffice((s) => s.token);
  const [busy, setBusy] = useState<ControlAction | null>(null);
  // The confirm step belongs to one run in one state: a different run, or a change made
  // elsewhere, drops it. It also expires after a few seconds.
  const key = `${run.run_id}:${run.control}`;
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirming = confirmKey === key;
  const setConfirming = (on: boolean) => setConfirmKey(on ? key : null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmKey) return;
    const t = setTimeout(() => setConfirmKey(null), 5000);
    return () => clearTimeout(t);
  }, [confirmKey]);

  const actions = allowedActions(run);
  if (!canOperate || !collector || actions.length === 0) return null;

  const act = async (action: ControlAction) => {
    if (action === "cancel" && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(action);
    setError(null);
    try {
      await controlRun(collector.url, collector.workspace, run.run_id, action, token);
    } catch (err) {
      setError(actionError(err, action === "cancel" ? "cancel the run" : `${action} the run`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Run controls">
      {actions.map((action) => {
        const Icon = busy === action ? Loader2 : ICON[action];
        const confirm = action === "cancel" && confirming;
        return (
          <button
            key={action}
            type="button"
            disabled={busy !== null}
            onClick={() => void act(action)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
              confirm ? "bg-[var(--st-error-fg)] text-[var(--surface)] hover:opacity-90" : "border border-border bg-surface hover:bg-surface-2"
            }`}
          >
            <Icon aria-hidden className={`size-4 ${busy === action ? "motion-safe:animate-spin" : ""}`} />
            {confirm ? "Confirm cancel" : LABEL[action]}
          </button>
        );
      })}
      <span role="status" className="sr-only">
        {confirming ? "Click Confirm cancel to stop this run. It can’t be undone." : ""}
      </span>
      {error && (
        <p role="alert" className="basis-full text-sm text-[var(--st-error-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}
