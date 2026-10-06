import type { Metadata } from "next";
import { connection } from "next/server";
import { collectorPagesAllowed } from "@/lib/publicDemo";
import { CompareView } from "@/components/compare/CompareView";

export const metadata: Metadata = {
  title: "Compare runs · AgentSpace",
  description: "What changed between two stored runs, and where they first differ.",
};

/**
 * `?run=` the run to look at (default: the latest failed one), `?base=` what to compare it with
 * (default: the latest successful run of the same workflow), plus the office's `?collector=` and `?workspace=`.
 */
export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  await connection();
  collectorPagesAllowed();
  const params = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const collectorUrl = pick(params.collector) ?? process.env.AGENTSPACE_PUBLIC_URL ?? "http://localhost:4800";
  const workspace = pick(params.workspace) ?? process.env.AGENTSPACE_WORKSPACE ?? "default";
  const query = new URLSearchParams();
  if (params.collector) query.set("collector", collectorUrl);
  if (params.workspace) query.set("workspace", workspace);
  const qs = query.size ? `?${query}` : "";
  return <CompareView collectorUrl={collectorUrl} workspace={workspace} runId={pick(params.run) ?? null} baseId={pick(params.base) ?? null} officeHref={`/${qs}`} />;
}
