/** Docs navigation. Each slug is a file in web/content/docs/<slug>.md ("index" is /docs). */
export const DOCS_NAV: { group: string; pages: { slug: string; title: string }[] }[] = [
  {
    group: "Get started",
    pages: [
      { slug: "index", title: "Introduction" },
      { slug: "quickstart", title: "Quickstart" },
      { slug: "concepts", title: "Concepts" },
    ],
  },
  {
    group: "Using the office",
    pages: [
      { slug: "approvals-and-controls", title: "Approvals, pause and cancel" },
      { slug: "costs", title: "Costs and pricing" },
      { slug: "replay-and-dashboard", title: "Replay and the Costs page" },
      { slug: "debugging", title: "Debugging a run" },
      { slug: "detectors", title: "Detectors" },
      { slug: "policy", title: "Oversight policy" },
    ],
  },
  {
    group: "SDKs",
    pages: [
      { slug: "python-sdk", title: "Python SDK" },
      { slug: "typescript-sdk", title: "TypeScript SDK" },
    ],
  },
  {
    group: "Integrations",
    pages: [
      { slug: "langgraph", title: "LangGraph" },
      { slug: "crewai", title: "CrewAI" },
      { slug: "openai-agents", title: "OpenAI Agents SDK" },
      { slug: "claude-agent-sdk", title: "Claude Agent SDK" },
      { slug: "claude-code", title: "Claude Code" },
      { slug: "opentelemetry", title: "OpenTelemetry (OTLP)" },
    ],
  },
  {
    group: "Reference",
    pages: [
      { slug: "self-hosting", title: "Self-hosting and configuration" },
      { slug: "security", title: "Security and auth" },
      { slug: "event-spec", title: "Event spec" },
      { slug: "rest-api", title: "Collector API" },
      { slug: "benchmarks", title: "Benchmarks" },
    ],
  },
];

export const DOCS_PAGES = DOCS_NAV.flatMap((g) => g.pages);
