/** Recorded example runs bundled with the web app (played by /demo, no collector needed). */
export interface RecordingInfo {
  id: string;
  label: string;
  file: string;
}

export const RECORDINGS: RecordingInfo[] = [
  { id: "dev-team", label: "LangGraph · dev team fixes a bug", file: "/recordings/dev-team.json" },
  { id: "crewai", label: "CrewAI · research desk", file: "/recordings/crewai-research-desk.json" },
  { id: "openai-agents", label: "OpenAI Agents · support handoff", file: "/recordings/openai-support-desk.json" },
  { id: "claude-agent-sdk", label: "Claude Agent SDK · approval", file: "/recordings/claude-support-desk.json" },
  { id: "otel", label: "OpenTelemetry only", file: "/recordings/otel-support-bot.json" },
];

export function recordingById(id: string | undefined): RecordingInfo {
  return RECORDINGS.find((r) => r.id === id) ?? RECORDINGS[0]!;
}
