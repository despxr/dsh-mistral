import test from 'node:test'
import assert from 'node:assert/strict'
import { priceFor, costOf } from '../lib/prices.js'

test('current Mistral prices are used', () => {
  assert.deepEqual(priceFor('deepseek-v4-1-flash-1017'), { input: 0.3, output: 1.2, cacheRead: 0.007 })
  assert.deepEqual(priceFor('zai-glm-5-3'), { input: 1.4, output: 4.4, cacheRead: 0.14 })
  assert.deepEqual(priceFor('zai-glm-5-3-flash'), { input: 0.15, output: 0.5, cacheRead: 0.03 })
  assert.deepEqual(priceFor('mistral-large-4-0-8'), { input: 0.7, output: 2.1, cacheRead: 0.07 })
  assert.deepEqual(priceFor('mistral-small-2603'), { input: 0.15, output: 0.6, cacheRead: 0.015 })
})

test('removed model is not priced', () => {
  assert.equal(priceFor('deepseek-v4-1-pro'), null)
})

test('cache reads bill at the cache rate', () => {
  const cost = costOf({ inputTokens: 6960, cacheReadTokens: 6784, outputTokens: 86 }, 'deepseek-v4-1-flash-1017')
  assert.equal(cost.priced, true)
  assert.ok(Math.abs(cost.total - 0.000203488) < 1e-12)
  assert.ok(Math.abs(cost.cacheRead - 0.000047488) < 1e-12)
})
