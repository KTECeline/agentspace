import type { Metadata } from "next";
import { connection } from "next/server";
import { collectorPagesAllowed } from "@/lib/publicDemo";
import { OfficeApp } from "@/components/OfficeApp";

export const metadata: Metadata = {
  title: "Replay · AgentSpace",
  description: "Replay a stored run in the AgentSpace office.",
};

/** `?run=` (required), plus the office's `?collector=` and `?workspace=`. */
export default async function ReplayPage({ searchParams }: PageProps<"/replay">) {
  await connection();
  collectorPagesAllowed();
  const params = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const collectorUrl = pick(params.collector) ?? process.env.AGENTSPACE_PUBLIC_URL ?? "http://localhost:4800";
  const workspace = pick(params.workspace) ?? process.env.AGENTSPACE_WORKSPACE ?? "default";
  const runId = pick(params.run);
  if (!runId) {
    return (
      <main className="mx-auto max-w-prose p-8">
        <h1 className="font-display text-xl font-semibold">Which run?</h1>
        <p className="mt-2 text-sm text-muted">
          Open a replay from the office (the Replay button next to the latest run) or from the Runs table on the Costs page. The address needs{" "}
          <code className="font-mono text-foreground">?run=&lt;run id&gt;</code>.
        </p>
      </main>
    );
  }
  return <OfficeApp source={{ kind: "replay", collectorUrl, workspace, runId }} />;
}
