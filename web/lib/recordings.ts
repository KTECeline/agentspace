/** Recorded example runs bundled with the web app (played by /demo, no collector needed). */
export interface RecordingInfo {
  id: string;
  label: string;
  file: string;
}

export const RECORDINGS: RecordingInfo[] = [
  // The failure story (examples/langgraph-dev-team --story): the first, so /demo opens on it.
  { id: "story", label: "Failure story · the run that goes wrong", file: "/recordings/story-failure.json" },
  { id: "story-good", label: "Failure story · a good run", file: "/recordings/story-good.json" },
  { id: "dev-team", label: "LangGraph · dev team fixes a bug", file: "/recordings/dev-team.json" },
  { id: "crewai", label: "CrewAI · research desk", file: "/recordings/crewai-research-desk.json" },
  { id: "openai-agents", label: "OpenAI Agents · support handoff", file: "/recordings/openai-support-desk.json" },
  { id: "claude-agent-sdk", label: "Claude Agent SDK · approval", file: "/recordings/claude-support-desk.json" },
  { id: "otel", label: "OpenTelemetry only", file: "/recordings/otel-support-bot.json" },
];

export function recordingById(id: string | undefined): RecordingInfo {
  return RECORDINGS.find((r) => r.id === id) ?? RECORDINGS[0]!;
}
