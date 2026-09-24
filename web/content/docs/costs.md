# Costs and pricing

Every `llm.call` event can carry a cost. AgentSpace keeps track of where each cost came from, and never passes off an estimate as a bill.

## Reported vs estimated

| The event has | The collector | The office shows |
|---|---|---|
| `cost_usd` (the framework reported it) | keeps it as is | the number |
| tokens and a model, but no cost | prices it from the table and sets `cost_source: "estimated"` | the number + **est.** |
| `cost_source: "reported"` and no cost | leaves it alone: its cost is on another event | (counted there) |
| tokens and a model that isn't in the table | leaves it unpriced, and counts it | "no price" |

For example, the Claude Agent SDK bills a whole session at the end (`total_cost_usd`). Its adapter marks each message `cost_source: "reported"` and attaches the session total once, so nothing is counted twice. That matters: in one real run, the billed cost was about 60% higher than the per-message tokens priced from the list.

Hovering a cost shows how much of it is estimated and how many calls had no price. The agent panel also shows the date of the prices used.

## The price table

The built-in table is `server/src/pricing/prices.json`. Each model entry has:

- `input`, `output`, and where relevant `cache_read` and `cache_write` prices in USD per 1M tokens;
- `as_of`: the date the price was checked, and `source`: the official pricing page it came from;
- optional price periods (`from`: a date) for announced changes, and `long_context` tiers where the provider publishes a threshold.

Model ids are matched exactly first, then normalized: provider prefixes (`anthropic/`, `models/`, Bedrock's `us.anthropic.`), date and version suffixes, and `@`/`:` tags are dropped, and `.` matches `-`. So `anthropic/claude-haiku-4.5` and `claude-haiku-4-5-20251001` both find `claude-haiku-4-5`. There's no fuzzy matching: an unknown model stays unpriced rather than borrowing a wrong price.

**Cached tokens** are part of `tokens_in`. `tokens_cache_read` and `tokens_cache_write` say how many, and get their own rates. Adapters fill them from each framework's usage data.

## Your own prices

Point `AGENTSPACE_PRICES_FILE` at a JSON file with the same shape as `GET /v1/pricing` to add models or correct prices (negotiated rates, for example). Its models replace built-in ones with the same id. A malformed file stops the collector at startup rather than pricing wrong.

```json
{
  "version": "our-contract-2026",
  "models": [
    {"id": "claude-sonnet-5", "as_of": "2026-09-01", "source": "https://example.com/contract",
     "prices": [{"input": 1.5, "output": 7.5, "cache_read": 0.15, "cache_write": 1.9}]}
  ]
}
```

## What estimates leave out

Estimates use standard list prices for text. They don't include batch or fast-mode pricing, regional or data-residency premiums, negotiated discounts, per-search tool fees, or image and audio tokens. Anthropic cache writes are priced at the 5-minute rate. Prices change: the table records when each was checked.
