import type { AgentStatus } from "@agentspace/spec-types";
import { STATUS_LABEL } from "@/lib/format";

export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--st-bg)] px-2 py-0.5 text-xs font-medium text-[var(--st-fg)]"
    >
      <span aria-hidden className="status-dot size-1.5 rounded-full bg-[var(--st-dot)]" />
      {STATUS_LABEL[status]}
    </span>
  );
}
