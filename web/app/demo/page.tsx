import type { Metadata } from "next";
import { OfficeApp } from "@/components/OfficeApp";
import { recordingById } from "@/lib/recordings";

export const metadata: Metadata = {
  title: "AgentSpace demo",
  description: "A recorded run of a LangGraph dev team, replayed in the AgentSpace office. No setup needed.",
};

/**
 * Recorded demo: plays /recordings/dev-team.json in a loop with no collector.
 *   ?scenario=crewai  pick a bundled recording (see lib/recordings.ts)
 *   ?speed=2        play faster
 *   ?stress=50      synthetic load instead: 50 agents at ?rate=100 events/s (shows an FPS meter)
 *   ?fps            show the FPS meter
 *   ?bench=20       UI load benchmark: after a 5 s warm-up, measure frame times for 20 s (bench/ui_load.md)
 */
export default async function DemoPage({ searchParams }: PageProps<"/demo">) {
  const params = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const num = (v: string | string[] | undefined, fallback: number, max: number) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  const source =
    params.stress !== undefined
      ? ({ kind: "stress", agents: num(params.stress, 50, 200), rate: num(params.rate, 100, 1000) } as const)
      : ({ kind: "recording", url: recordingById(pick(params.scenario)).file, speed: num(params.speed, 1, 16) } as const);
  const scenario = params.stress !== undefined ? undefined : recordingById(pick(params.scenario)).id;
  const benchSeconds = params.bench !== undefined ? num(params.bench, 20, 300) : undefined;
  return <OfficeApp source={source} scenario={scenario} showFps={params.stress !== undefined || params.fps !== undefined} benchSeconds={benchSeconds} />;
}
