/**
 * Collector-side cost estimates (D-037, D-038).
 *
 * An `llm.call` with tokens but neither `cost_usd` nor `cost_source` is priced from the table
 * and marked `cost_source: "estimated"`. Anything the framework reported is left alone.
 */
import { readFileSync } from "node:fs";
import type { AgentSpaceEvent, PriceTable, ModelPrice, PricePeriod, PriceTier } from "@agentspace/spec-types";
import builtin from "./prices.json" with { type: "json" };

export const PRICE_AS_OF_ATTR = "agentspace.price_as_of";
export const PRICE_MODEL_ATTR = "agentspace.price_model";

/**
 * Map the many spellings of a model id to one key:
 * `anthropic/claude-haiku-4.5`, `us.anthropic.claude-haiku-4-5-20251001-v1:0`,
 * `claude-haiku-4-5@20251001` and `models/gemini-2.5-pro` all resolve to their table ids.
 */
export function normalizeModel(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.slice(s.lastIndexOf("/") + 1); // OpenRouter / Gemini "models/" / provider prefixes
  s = s.replace(/^(?:[a-z]{2,6}\.)?(?:anthropic|openai|google|amazon|meta)\./, ""); // Bedrock
  s = s.replace(/-v\d+(?::\d+)?$/, ""); // Bedrock version suffix
  s = s.replace(/[@:].*$/, ""); // Vertex "@20251001", OpenRouter ":free" / ":beta"
  s = s.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, ""); // dated snapshots
  s = s.replace(/-latest$/, "");
  return s.replace(/\./g, "-");
}

const key = (id: string) => id.trim().toLowerCase().replace(/\./g, "-");

export class Pricer {
  readonly table: PriceTable;
  private readonly exact = new Map<string, ModelPrice>();
  private readonly byKey = new Map<string, ModelPrice>();

  /** Later tables win, model by model (used for `AGENTSPACE_PRICES_FILE`). */
  constructor(...tables: PriceTable[]) {
    const models = new Map<string, ModelPrice>();
    for (const t of tables) for (const m of t.models) models.set(m.id, m);
    this.table = { version: tables.map((t) => t.version).join("+"), models: [...models.values()] };
    for (const m of this.table.models) {
      for (const id of [m.id, ...(m.aliases ?? [])]) {
        this.exact.set(id.toLowerCase(), m);
        this.byKey.set(key(id), m);
      }
    }
  }

  lookup(model: string): ModelPrice | undefined {
    return this.exact.get(model.trim().toLowerCase()) ?? this.byKey.get(normalizeModel(model));
  }

  /** The event with an estimated cost, or the same event if it isn't ours to price. */
  apply(ev: AgentSpaceEvent): AgentSpaceEvent {
    if (ev.type !== "llm.call" || ev.cost_usd !== undefined || ev.cost_source !== undefined || !ev.model) return ev;
    const tin = ev.tokens_in ?? 0;
    const tout = ev.tokens_out ?? 0;
    if (tin + tout === 0) return ev;
    const model = this.lookup(ev.model);
    const period = model && periodAt(model.prices, ev.ts);
    if (!model || !period) return ev;
    return {
      ...ev,
      cost_usd: estimate(period, tin, tout, ev.tokens_cache_read ?? 0, ev.tokens_cache_write ?? 0),
      cost_source: "estimated",
      attributes: { ...ev.attributes, [PRICE_MODEL_ATTR]: model.id, [PRICE_AS_OF_ATTR]: model.as_of },
    };
  }
}

/** The price period in force at `ts` (periods are ordered; the first has no `from`). */
function periodAt(prices: PricePeriod[], ts: string): PricePeriod | undefined {
  const day = ts.slice(0, 10);
  let current: PricePeriod | undefined;
  for (const p of prices) if (!p.from || p.from <= day) current = p;
  return current;
}

/** USD for one call. Cached tokens are part of `tokens_in`; missing cache prices fall back to input. */
export function estimate(period: PricePeriod, tin: number, tout: number, cacheRead: number, cacheWrite: number): number {
  const tier: PriceTier = period.long_context && tin > period.long_context.above_input_tokens ? period.long_context : period;
  const cr = Math.min(cacheRead, tin);
  const cw = Math.min(cacheWrite, tin - cr);
  const usd = ((tin - cr - cw) * tier.input + cr * (tier.cache_read ?? tier.input) + cw * (tier.cache_write ?? tier.input) + tout * tier.output) / 1e6;
  return Math.round(usd * 1e10) / 1e10; // drop float noise, keep sub-cent precision
}

/** The built-in table, plus overrides from a local JSON file of the same shape. */
export function loadPricer(overridePath: string | null): Pricer {
  const base = builtin as PriceTable;
  if (!overridePath) return new Pricer(base);
  let extra: unknown;
  try {
    extra = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (err) {
    throw new Error(`AGENTSPACE_PRICES_FILE: can't read ${overridePath}: ${(err as Error).message}`, { cause: err });
  }
  const problem = checkTable(extra);
  if (problem) throw new Error(`AGENTSPACE_PRICES_FILE: ${problem}`);
  return new Pricer(base, extra as PriceTable);
}

/** A short description of the first problem in a price table, or null. */
export function checkTable(t: unknown): string | null {
  const obj = t as Partial<PriceTable> | null;
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.models)) return 'expected {"version": "...", "models": [...]}';
  if (typeof obj.version !== "string") return '"version" must be a string (for example the date you checked the prices)';
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const [i, m] of obj.models.entries()) {
    const where = `models[${i}]`;
    if (!m || typeof m.id !== "string" || !m.id) return `${where}.id must be a non-empty string`;
    if (typeof m.as_of !== "string" || typeof m.source !== "string") return `${where} (${m.id}) needs "as_of" and "source"`;
    if (!Array.isArray(m.prices) || !m.prices.length) return `${where} (${m.id}) needs at least one entry in "prices"`;
    for (const p of m.prices) {
      const tiers: unknown[] = [p, p.long_context].filter(Boolean);
      for (const tier of tiers as PriceTier[]) {
        if (!num(tier.input) || !num(tier.output)) return `${where} (${m.id}): input and output must be numbers >= 0`;
        if ((tier.cache_read !== undefined && !num(tier.cache_read)) || (tier.cache_write !== undefined && !num(tier.cache_write)))
          return `${where} (${m.id}): cache prices must be numbers >= 0`;
      }
    }
  }
  return null;
}
