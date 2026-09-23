import type { Metadata } from "next";
import { OfficeApp } from "@/components/OfficeApp";

export const metadata: Metadata = {
  title: "AgentSpace demo",
  description: "A recorded run of a LangGraph dev team, replayed in the AgentSpace office. No setup needed.",
};

/**
 * Recorded demo: plays /recordings/dev-team.json in a loop with no collector.
 *   ?speed=2        play faster
 *   ?stress=50      synthetic load instead: 50 agents at ?rate=100 events/s
 */
export default async function DemoPage({ searchParams }: PageProps<"/demo">) {
  const params = await searchParams;
  const num = (v: string | string[] | undefined, fallback: number, max: number) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  const source =
    params.stress !== undefined
      ? ({ kind: "stress", agents: num(params.stress, 50, 200), rate: num(params.rate, 100, 1000) } as const)
      : ({ kind: "recording", url: "/recordings/dev-team.json", speed: num(params.speed, 1, 16) } as const);
  return <OfficeApp source={source} />;
}
