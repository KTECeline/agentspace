import { costInfo, type CostTotals } from "@/lib/format";

/**
 * A cost total with an "est." tag when any of it was estimated by the collector (D-037).
 * The explanation is a tooltip for pointers and plain text for screen readers.
 */
export function Cost({ totals, className }: { totals: CostTotals; className?: string }) {
  const { text, estimated, note } = costInfo(totals);
  return (
    <span className={className} title={note ?? undefined}>
      {text}
      {estimated ? (
        <span aria-hidden className="ml-1 font-sans text-[0.75em] font-medium text-muted">
          est.
        </span>
      ) : (
        totals.cost_usd === 0 &&
        totals.unpriced_calls > 0 && (
          <span aria-hidden className="ml-1 font-sans text-[0.75em] font-medium text-muted">
            no price
          </span>
        )
      )}
      {note && <span className="sr-only"> ({note})</span>}
    </span>
  );
}
