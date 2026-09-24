"use client";

import { useRouter } from "next/navigation";
import { RECORDINGS } from "@/lib/recordings";

/** Demo-only: switch between bundled recordings. */
export function ScenarioPicker({ current }: { current: string }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Scenario</span>
      <select
        value={current}
        onChange={(e) => router.push(`/demo?scenario=${encodeURIComponent(e.target.value)}`)}
        className="h-9 rounded-md border border-border bg-surface-2 px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {RECORDINGS.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}
