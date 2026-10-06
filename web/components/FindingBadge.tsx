import { TriangleAlert } from "lucide-react";

/**
 * The incident marker for an agent with detector findings in its current run (D-044). Amber, not
 * red: a finding is "look at this", not a failure. The count is also spoken.
 */
export function FindingBadge({ count, className = "" }: { count: number | undefined; className?: string }) {
  if (!count || count <= 0) return null; // also an older collector, which sends no count
  const label = `${count} ${count === 1 ? "finding" : "findings"}`;
  return (
    <span
      data-status="using_tool"
      title={`${label} in this run`}
      className={`inline-flex items-center gap-1 rounded-full border border-[var(--st-dot)] bg-[var(--st-bg)] px-1.5 py-px text-[11px] font-semibold text-[var(--st-fg)] ${className}`}
    >
      <TriangleAlert aria-hidden className="size-3" />
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
