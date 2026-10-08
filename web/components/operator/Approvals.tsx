"use client";

import { useId, useMemo, useState } from "react";
import { Check, Inbox, Loader2, ShieldAlert, X } from "lucide-react";
import type { ApprovalState } from "@agentspace/spec-types";
import { actionError, resolveApproval } from "@/lib/collector";
import { formatDuration, timeAgo } from "@/lib/format";
import { approvalWhy } from "@/lib/oversight";
import { useCanOperate, useOffice } from "@/lib/store";
import { useNow } from "@/lib/useNow";

const RECENT = 10;

/** Pending approvals first (oldest first: it has waited longest), then the latest decisions. */
export function sortApprovals(list: ApprovalState[]): { pending: ApprovalState[]; recent: ApprovalState[] } {
  const pending = list.filter((a) => a.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const recent = list
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.resolved_at ?? b.created_at).localeCompare(a.resolved_at ?? a.created_at))
    .slice(0, RECENT);
  return { pending, recent };
}

export function usePendingCount(): number {
  return useOffice((s) => Object.values(s.approvals).reduce((n, a) => n + (a.status === "pending" ? 1 : 0), 0));
}

/** The approvals inbox (right column tab). */
export function ApprovalsPanel() {
  const approvals = useOffice((s) => s.approvals);
  const { pending, recent } = useMemo(() => sortApprovals(Object.values(approvals)), [approvals]);
  return (
    <section aria-label="Approvals" className="flex max-h-[70vh] min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-border bg-surface lg:max-h-none">
      {pending.length === 0 && recent.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-10 text-center">
          <Inbox aria-hidden className="size-8 text-muted" />
          <h2 className="font-medium">No approvals yet</h2>
          <p className="max-w-xs text-sm text-muted">
            When an agent calls <code className="font-mono text-foreground">request_approval()</code>, it waits here for you.
          </p>
        </div>
      ) : (
        <>
          <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-muted">Waiting for you ({pending.length})</h2>
          {pending.length === 0 ? (
            <p className="px-4 pb-4 pt-1 text-sm text-muted">Nothing is waiting.</p>
          ) : (
            <ul className="flex flex-col gap-3 p-4">
              {pending.map((a) => (
                <li key={a.approval_id}>
                  <ApprovalCard approval={a} />
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <>
              <h2 className="border-t border-border px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-muted">Recent decisions</h2>
              <ul className="flex flex-col gap-3 p-4">
                {recent.map((a) => (
                  <li key={a.approval_id}>
                    <ApprovalCard approval={a} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

const DECISION_TONE: Record<ApprovalState["status"], string> = {
  pending: "waiting_human",
  approved: "done",
  rejected: "error",
  timeout: "waiting",
};

const DECISION_LABEL: Record<ApprovalState["status"], string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  timeout: "Timed out",
};

/** One approval: what's asked, by whom, and (for operators) approve / reject with a comment. */
export function ApprovalCard({ approval: a, showAgent = true }: { approval: ApprovalState; showAgent?: boolean }) {
  const agentName = useOffice((s) => (a.agent_id ? (s.agents[a.agent_id]?.name ?? a.agent_id) : null));
  const collector = useOffice((s) => s.collector);
  const token = useOffice((s) => s.token);
  const publicMode = useOffice((s) => !!s.info?.public_readonly);
  const canOperate = useCanOperate();
  const now = useNow();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commentId = useId();
  const pending = a.status === "pending";
  const left = a.expires_at ? Date.parse(a.expires_at) - now : null;

  const decide = async (decision: "approved" | "rejected") => {
    if (!collector) return;
    setBusy(decision);
    setError(null);
    try {
      // The WebSocket brings the new state; nothing else to update here.
      await resolveApproval(collector.url, collector.workspace, a.approval_id, decision, comment, token);
    } catch (err) {
      setError(actionError(err, decision === "approved" ? "approve" : "reject"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      aria-label={`Approval: ${a.reason}`}
      className={`flex flex-col gap-3 rounded-lg border p-3 ${pending ? "border-[var(--st-human-dot)] bg-background" : "border-border"}`}
    >
      <header className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words font-medium">{a.reason}</p>
        <span data-status={DECISION_TONE[a.status]} className="shrink-0 rounded-full bg-[var(--st-bg)] px-2 py-0.5 text-xs font-medium text-[var(--st-fg)]">
          {DECISION_LABEL[a.status]}
        </span>
      </header>
      <p className="text-sm text-muted">
        {showAgent && agentName ? `${agentName} · ` : ""}
        asked {timeAgo(a.created_at, now)}
        {pending && left != null && (left > 0 ? ` · times out in ${formatDuration(left)}` : " · timing out…")}
        {!pending && a.resolved_by && ` · by ${a.resolved_by}`}
      </p>
      {a.comment && !pending && <p className="rounded-md bg-surface-2 px-3 py-2 text-sm">“{a.comment}”</p>}

      <WhyAsked approval={a} />

      {publicMode ? (
        <p className="text-sm text-muted">Details are hidden in this read-only office.</p>
      ) : (
        a.payload != null && (
          <details className="group rounded-md bg-surface-2" open={pending}>
            <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Details
            </summary>
            <pre className="max-h-60 overflow-auto px-3 pb-3 font-mono text-xs">{formatPayload(a.payload)}</pre>
          </details>
        )
      )}

      {pending && canOperate && (
        <div className="flex flex-col gap-2">
          <label htmlFor={commentId} className="sr-only">
            Comment for the agent (optional)
          </label>
          <textarea
            id={commentId}
            rows={2}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            placeholder="Comment for the agent (optional)"
            className="resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide("approved")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
            >
              {busy === "approved" ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" /> : <Check aria-hidden className="size-4" />}
              Approve
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide("rejected")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {busy === "rejected" ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" /> : <X aria-hidden className="size-4" />}
              Reject
            </button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-[var(--st-error-fg)]">
              {error}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** Which policy rule asked, and the run so far against the workflow's usual runs (D-045). */
function WhyAsked({ approval }: { approval: ApprovalState }) {
  const live = useOffice((s) => s.connection === "live");
  const why = approvalWhy(approval);
  if (!why) return null;
  return (
    <section aria-label="Why you're asked" className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
      <p className="flex items-start gap-1.5">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
        <span className="min-w-0">
          <span className="font-medium">{why.rule}</span>
          {why.reason && <span className="text-muted"> · {why.reason}</span>}
        </span>
      </p>
      {why.escalated && (
        <p data-status="using_tool" className="rounded-md bg-[var(--st-bg)] px-2 py-1 text-xs font-medium text-[var(--st-fg)]">
          Asked because this run has detector findings.
        </p>
      )}
      {why.loading ? (
        live && <p className="text-xs text-muted">Gathering evidence…</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {why.lines.map((l) => (
            <div key={l.label} className="contents" data-status={l.unusual ? "using_tool" : undefined}>
              <dt className="text-muted">{l.label}</dt>
              <dd className={`min-w-0 break-words font-mono tabular-nums ${l.unusual ? "font-semibold text-[var(--st-fg)]" : ""}`}>
                {l.value}
                {l.unusual && <span className="sr-only"> (unusual)</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {why.findings.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Findings in this run">
          {why.findings.map((f, i) => (
            <li key={i} data-status={f.severity === "critical" ? "error" : "using_tool"} className="rounded-md bg-[var(--st-bg)] px-2 py-1 text-[var(--st-fg)]">
              {f.message}
              <span className="text-muted"> · {f.detector.replace(/_/g, " ")}{f.severity === "critical" ? " · critical" : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}
