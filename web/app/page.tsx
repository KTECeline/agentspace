import { connection } from "next/server";
import { Office } from "@/components/Office";

/**
 * The collector URL is read at request time (not NEXT_PUBLIC_*, which is frozen at build time),
 * so one Docker image works in any environment. `?workspace=` and `?collector=` override it.
 */
export default async function Page({ searchParams }: PageProps<"/">) {
  await connection();
  const params = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const collectorUrl = pick(params.collector) ?? process.env.AGENTSPACE_PUBLIC_URL ?? "http://localhost:4800";
  const workspace = pick(params.workspace) ?? process.env.AGENTSPACE_WORKSPACE ?? "default";
  return <Office collectorUrl={collectorUrl} workspace={workspace} />;
}
