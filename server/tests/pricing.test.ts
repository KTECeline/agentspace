import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentSpaceEvent, PriceTable, StoredEvent } from "@agentspace/spec-types";
import { checkTable, loadPricer, normalizeModel, Pricer } from "../src/pricing/index.js";
import builtin from "../src/pricing/prices.json" with { type: "json" };
import { ev, makeApp } from "./helpers.js";

const table = builtin as PriceTable;
const pricer = new Pricer(table);

function llm(extra: Partial<AgentSpaceEvent> = {}): AgentSpaceEvent {
  return ev({ type: "llm.call", agent_id: "a", data: { provider: "anthropic" }, ...extra } as Parameters<typeof ev>[0]);
}

describe("price table", () => {
  it("is well formed: every model has as_of, an official source URL and valid prices", () => {
    expect(checkTable(table)).toBeNull();
    for (const m of table.models) {
      expect(m.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.source).toMatch(/^https:\/\/(platform\.claude\.com|developers\.openai\.com|ai\.google\.dev)\//);
    }
    const ids = table.models.flatMap((m) => [m.id, ...(m.aliases ?? [])]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("normalizeModel", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["anthropic/claude-haiku-4.5", "claude-haiku-4-5"],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
    ["claude-haiku-4-5@20251001", "claude-haiku-4-5"],
    ["openai/gpt-5.4-mini", "gpt-5-4-mini"],
    ["gpt-4o-2024-08-06", "gpt-4o"],
    ["models/gemini-2.5-pro", "gemini-2-5-pro"],
    ["openrouter/anthropic/claude-sonnet-5:beta", "claude-sonnet-5"],
    ["Claude-Sonnet-5", "claude-sonnet-5"],
  ])("%s -> %s", (raw, want) => expect(normalizeModel(raw)).toBe(want));

  it("prefers an exact id over a normalized one (dated snapshots with their own price)", () => {
    expect(pricer.lookup("gpt-4o-2024-05-13")?.id).toBe("gpt-4o-2024-05-13");
    expect(pricer.lookup("gpt-4o-2024-08-06")?.id).toBe("gpt-4o");
    expect(pricer.lookup("claude-opus-4-0")?.id).toBe("claude-opus-4");
    expect(pricer.lookup("scripted-fake")).toBeUndefined();
  });
});

describe("Pricer.apply", () => {
  it("estimates input and output (Claude Haiku 4.5: $1 in, $5 out per 1M)", () => {
    const out = pricer.apply(llm({ model: "claude-haiku-4-5-20251001", tokens_in: 10_000, tokens_out: 2_000 }));
    expect(out.cost_usd).toBeCloseTo(0.01 + 0.01, 10);
    expect(out.cost_source).toBe("estimated");
    expect(out.attributes).toMatchObject({ "agentspace.price_model": "claude-haiku-4-5", "agentspace.price_as_of": "2026-09-24" });
  });

  it("prices cache reads and writes at their own rates (they are part of tokens_in)", () => {
    // 10k in = 6k cache read ($0.10) + 1k cache write ($1.25) + 3k uncached ($1); 1k out ($5).
    const out = pricer.apply(
      llm({ model: "claude-haiku-4-5", tokens_in: 10_000, tokens_out: 1_000, tokens_cache_read: 6_000, tokens_cache_write: 1_000 }),
    );
    expect(out.cost_usd).toBeCloseTo((3_000 * 1 + 6_000 * 0.1 + 1_000 * 1.25 + 1_000 * 5) / 1e6, 10);
  });

  it("clamps cache counts that exceed tokens_in", () => {
    const out = pricer.apply(llm({ model: "claude-haiku-4-5", tokens_in: 100, tokens_out: 0, tokens_cache_read: 500 }));
    expect(out.cost_usd).toBeCloseTo((100 * 0.1) / 1e6, 12);
  });

  it("falls back to the input price when a model has no cache price", () => {
    const out = pricer.apply(llm({ model: "gpt-5-pro", tokens_in: 1_000, tokens_out: 0, tokens_cache_read: 1_000 }));
    expect(out.cost_usd).toBeCloseTo((1_000 * 15) / 1e6, 12);
  });

  it("uses the long-context tier above its threshold", () => {
    const short = pricer.apply(llm({ model: "gemini-2.5-pro", tokens_in: 200_000, tokens_out: 0 }));
    const long = pricer.apply(llm({ model: "gemini-2.5-pro", tokens_in: 200_001, tokens_out: 0 }));
    expect(short.cost_usd).toBeCloseTo((200_000 * 1.25) / 1e6, 8);
    expect(long.cost_usd).toBeCloseTo((200_001 * 2.5) / 1e6, 8);
  });

  it("picks the price period in force at the event's timestamp", () => {
    const before = pricer.apply(llm({ model: "gemini-3.8-flash", tokens_in: 1_000_000, tokens_out: 0, ts: "2026-12-31T23:59:59Z" }));
    const after = pricer.apply(llm({ model: "gemini-3.8-flash", tokens_in: 1_000_000, tokens_out: 0, ts: "2027-01-01T00:00:00Z" }));
    expect([before.cost_usd, after.cost_usd]).toEqual([0.75, 1.5]);
  });

  it("never touches a reported cost, a reported-elsewhere call, other events or unknown models", () => {
    const reported = llm({ model: "claude-haiku-4-5", tokens_in: 1000, cost_usd: 0.5 });
    const elsewhere = llm({ model: "claude-haiku-4-5", tokens_in: 1000, cost_source: "reported" });
    const unknown = llm({ model: "scripted-fake", tokens_in: 1000 });
    const noTokens = llm({ model: "claude-haiku-4-5" });
    const status = ev({ type: "agent.status", agent_id: "a", model: "claude-haiku-4-5", tokens_in: 1000, data: { status: "thinking" } });
    for (const e of [reported, elsewhere, unknown, noTokens, status]) expect(pricer.apply(e)).toBe(e);
  });
});

describe("AGENTSPACE_PRICES_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentspace-prices-"));
  const write = (name: string, body: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  };

  it("adds and overrides models by id", () => {
    const path = write("ok.json", {
      version: "local",
      models: [
        { id: "my-local-model", as_of: "2026-09-24", source: "https://example.com/prices", prices: [{ input: 0.5, output: 1 }] },
        { id: "claude-haiku-4-5", as_of: "2026-09-24", source: "https://example.com/deal", prices: [{ input: 0.5, output: 2.5 }] },
      ],
    });
    const p = loadPricer(path);
    expect(p.table.version).toBe(`${table.version}+local`);
    expect(p.lookup("my-local-model")?.prices[0]?.input).toBe(0.5);
    expect(p.lookup("claude-haiku-4-5-20251001")?.source).toBe("https://example.com/deal");
    expect(p.table.models.length).toBe(table.models.length + 1);
  });

  it("fails loudly on a bad file instead of pricing wrong", () => {
    expect(() => loadPricer(join(dir, "missing.json"))).toThrow(/can't read/);
    expect(() => loadPricer(write("bad.json", "{"))).toThrow(/can't read/);
    expect(() => loadPricer(write("shape.json", { version: "x", models: [{ id: "m", as_of: "d", source: "s", prices: [{ input: -1, output: 1 }] }] }))).toThrow(
      /numbers >= 0/,
    );
  });
});

describe("collector", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("prices llm.call events at ingest and stores the estimate", async () => {
    ({ app } = await makeApp());
    const events = [
      llm({ id: "p1", model: "claude-haiku-4-5", tokens_in: 1_000_000, tokens_out: 0 }),
      llm({ id: "p2", model: "claude-haiku-4-5", tokens_in: 5, cost_usd: 0.25 }),
    ];
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events } });
    expect(res.json()).toMatchObject({ accepted: 2 });
    const stored = (await app.inject({ url: "/v1/workspaces/default/runs/run-1/events" })).json() as StoredEvent[];
    const byId = Object.fromEntries(stored.map((e) => [e.id, e]));
    expect(byId.p1).toMatchObject({ cost_usd: 1, cost_source: "estimated" });
    expect(byId.p2).toMatchObject({ cost_usd: 0.25 });
    expect(byId.p2!.cost_source).toBeUndefined();
  });

  it("serves the price table without a token, even when reads need one", async () => {
    ({ app } = await makeApp({ AGENTSPACE_OPERATOR_TOKEN: "op" }));
    const res = await app.inject({ url: "/v1/pricing" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as PriceTable).models.some((m) => m.id === "claude-sonnet-5")).toBe(true);
  });
});
