"use client";

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { teamLabel } from "@/lib/format";
import { groupByTeam } from "@/lib/state";
import { useOffice } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import { AgentCard } from "../AgentCard";

/** The low-power 2D office: agent cards grouped by team. */
export function Grid2D() {
  const agents = useOffice(useShallow((s) => Object.values(s.agents)));
  const selected = useOffice((s) => s.selectedAgent);
  const select = useOffice((s) => s.select);
  const teams = useMemo(() => groupByTeam(agents), [agents]);
  const now = useNow();

  return (
    <div className="flex flex-col gap-6">
      {teams.map((team) => (
        <section key={team.id || "_none"} aria-labelledby={`team-${team.id}`}>
          <h2 id={`team-${team.id}`} className="mb-3 flex items-baseline gap-2 text-sm font-semibold">
            {teamLabel(team.id)}
            <span className="font-normal text-muted">
              {team.agents.length} agent{team.agents.length === 1 ? "" : "s"}
            </span>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {team.agents.map((a) => (
              <AgentCard key={a.agent_id} agent={a} now={now} selected={selected === a.agent_id} onSelect={(id) => select(selected === id ? null : id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
