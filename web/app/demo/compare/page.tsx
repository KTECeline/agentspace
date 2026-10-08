import type { Metadata } from "next";
import { CompareView } from "@/components/compare/CompareView";

export const metadata: Metadata = {
  title: "Compare recorded runs · AgentSpace demo",
  description: "A failing run next to a good one: what changed, and where they first differ. Recorded, no setup needed.",
};

/**
 * Compare over the recordings bundled with the app (no collector, so it's allowed in public demo
 * mode). `?run=` / `?base=` pick runs; by default the latest failed run against the latest good
 * run of the same workflow.
 */
export default async function DemoComparePage({ searchParams }: PageProps<"/demo/compare">) {
  const params = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <CompareView source={{ kind: "recordings" }} runId={pick(params.run) ?? null} baseId={pick(params.base) ?? null} officeHref="/demo" />;
}
