import type { Metadata } from "next";
import { connection } from "next/server";
import { Dashboard } from "@/components/dashboard/Dashboard";

export const metadata: Metadata = {
  title: "Costs · AgentSpace",
  description: "Cost, latency and errors for an AgentSpace workspace.",
};

/** Same `?collector=` and `?workspace=` parameters as the office. */
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  await connection();
  const params = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const collectorUrl = pick(params.collector) ?? process.env.AGENTSPACE_PUBLIC_URL ?? "http://localhost:4800";
  const workspace = pick(params.workspace) ?? process.env.AGENTSPACE_WORKSPACE ?? "default";
  const query = new URLSearchParams();
  if (params.collector) query.set("collector", collectorUrl);
  if (params.workspace) query.set("workspace", workspace);
  const qs = query.size ? `?${query}` : "";
  return <Dashboard collectorUrl={collectorUrl} workspace={workspace} officeHref={`/${qs}`} />;
}
