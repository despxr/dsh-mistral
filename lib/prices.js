/**
 * Per-model pricing for Mistral routes.
 *
 * The upstream `dsh-chat-cost` plugin resolves prices from a models.dev snapshot
 * and maps harness routes through a fixed table. Two things break it for Mistral:
 *
 *   1. It only knows the route `mistral`, not `mistral-pro`, so the lookup
 *      returns null and the cost renders blank.
 *   2. Its catalog (generated 2026-09-12) predates the current model ids —
 *      `deepseek-v4-1-flash-1017`, `zai-glm-5-3` and `mistral-large-4` are all
 *      absent.
 *
 * This module carries its own table, keyed by the ids Mistral actually serves,
 * and is the single source of truth for cost in this plugin.
 *
 * Units: USD per 1,000,000 tokens. Cache reads bill at `cacheRead`; cache writes
 * at `cacheWrite` when the provider charges for them (Mistral does not).
 */

/** @typedef {{input:number, output:number, cacheRead?:number, cacheWrite?:number}} Price */

/** Price table, USD per 1M tokens. */
export const PRICES = {
  // DeepSeek on Mistral — the default route.
  'deepseek-v4-1-flash-1017': { input: 0.27, output: 1.1, cacheRead: 0.027 },
  'deepseek-v4-1-pro': { input: 0.55, output: 2.19, cacheRead: 0.055 },

  // GLM on Mistral.
  'zai-glm-5-3': { input: 0.6, output: 2.2, cacheRead: 0.06 },
  'zai-glm-5-3-flash': { input: 0.15, output: 0.6, cacheRead: 0.015 },
  'zai-glm-5-2': { input: 0.6, output: 2.2, cacheRead: 0.06 },

  // Mistral's own.
  'mistral-large-4': { input: 2, output: 6, cacheRead: 0.2 },
  'mistral-large-latest': { input: 2, output: 6, cacheRead: 0.2 },
  'mistral-medium-latest': { input: 0.4, output: 2, cacheRead: 0.04 },
  'mistral-small-latest': { input: 0.1, output: 0.3, cacheRead: 0.01 },
  'codestral-latest': { input: 0.3, output: 0.9, cacheRead: 0.03 },
  'magistral-medium-latest': { input: 2, output: 5, cacheRead: 0.2 },
  'devstral-latest': { input: 0.4, output: 2, cacheRead: 0.04 },
}

/** Fallback when a model has no row: assume a mid-tier price rather than 0. */
export const UNKNOWN_PRICE = { input: 1, output: 3, cacheRead: 0.1 }

/**
 * Normalise a model id to a price-table key.
 *
 * Handles provider prefixes (`mistral/deepseek-v4-1-flash-1017`), batch suffixes
 * (`:batch`) and the dot/dash spelling drift seen across Mistral endpoints
 * (`deepseek-v4.1-flash` vs `deepseek-v4-1-flash`).
 *
 * @param {string} model
 * @returns {string}
 */
export function canonicalModelId(model) {
  if (typeof model !== 'string') return ''
  let id = model.trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  const colon = id.indexOf(':')
  if (colon !== -1) id = id.slice(0, colon)
  return id.replace(/\./g, '-')
}

/**
 * Price row for a model, or null when unknown.
 *
 * @param {string} model
 * @returns {Price|null}
 */
export function priceFor(model) {
  const id = canonicalModelId(model)
  if (!id) return null
  if (PRICES[id]) return PRICES[id]
  // Prefix match: `deepseek-v4-1-flash-1017-preview` inherits the base row.
  const hit = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((key) => id.startsWith(key))
  return hit ? PRICES[hit] : null
}

/**
 * Cost in USD for one request's usage.
 *
 * Cache reads bill at the discounted rate; the remainder bills at the input
 * rate. Mistral reports `cached_tokens` as a subset of the input count, so the
 * uncached portion is `input - cached`.
 *
 * @param {{inputTokens?:number, outputTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number}} usage
 * @param {string} model
 * @returns {{total:number, input:number, output:number, cacheRead:number, cacheWrite:number, priced:boolean, price:Price}}
 */
export function costOf(usage, model) {
  const price = priceFor(model) ?? UNKNOWN_PRICE
  const priced = priceFor(model) !== null
  const input = Math.max(0, Number(usage?.inputTokens) || 0)
  const output = Math.max(0, Number(usage?.outputTokens) || 0)
  const cacheRead = Math.min(input, Math.max(0, Number(usage?.cacheReadTokens) || 0))
  const cacheWrite = Math.max(0, Number(usage?.cacheWriteTokens) || 0)
  const uncached = Math.max(0, input - cacheRead)

  const per = 1_000_000
  const inputCost = (uncached * price.input) / per
  const cacheReadCost = (cacheRead * (price.cacheRead ?? price.input)) / per
  const cacheWriteCost = (cacheWrite * (price.cacheWrite ?? 0)) / per
  const outputCost = (output * price.output) / per

  return {
    total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    priced,
    price,
  }
}

/**
 * Sum costs across turns, keeping per-model totals.
 *
 * @param {Array<{model:string, usage:object}>} turns
 * @returns {{total:number, byModel:Record<string, {total:number, turns:number, inputTokens:number, outputTokens:number, cacheReadTokens:number}>}}
 */
export function totalCost(turns) {
  const byModel = {}
  let total = 0
  for (const turn of turns ?? []) {
    const model = canonicalModelId(turn?.model) || 'unknown'
    const cost = costOf(turn?.usage, turn?.model)
    total += cost.total
    const row = (byModel[model] ??= {
      total: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    })
    row.total += cost.total
    row.turns += 1
    row.inputTokens += Number(turn?.usage?.inputTokens) || 0
    row.outputTokens += Number(turn?.usage?.outputTokens) || 0
    row.cacheReadTokens += Number(turn?.usage?.cacheReadTokens) || 0
  }
  return { total, byModel }
}

/** Format a USD amount for display. */
export function formatUSD(amount) {
  const n = Number(amount) || 0
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}
