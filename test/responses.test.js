import test from 'node:test'
import assert from 'node:assert/strict'
import { toResponsesContent, toResponsesInput, responsesEventToChunk, tokenUsageFromChat } from '../lib/responses.js'

const image = 'data:image/png;base64,AAAA'

test('user text and image use Responses content parts', () => {
  const input = toResponsesInput([
    { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image_url', image_url: { url: image } }] },
  ])
  assert.deepEqual(input, [
    { role: 'user', content: [{ type: 'input_text', text: 'What color?' }, { type: 'input_image', detail: 'auto', image_url: image }] },
  ])
})

test('assistant text, tool calls and reasoning replay are emitted', () => {
  const input = toResponsesInput([
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'APPLE' },
        { type: 'tool-call', id: 'chatcmpl-tool-1', name: 'get', arguments: '{}' },
      ],
      replayState: {
        response: { adapter: 'dsh-mistral' },
        blocks: [{ type: 'reasoning', id: 'rs_1', status: 'completed', content: [] }, undefined, undefined],
      },
    },
  ])
  assert.deepEqual(input, [
    { type: 'reasoning', id: 'rs_1', status: 'completed', content: [] },
    { role: 'assistant', content: 'APPLE' },
    { type: 'function_call', call_id: 'chatcmpl-tool-1', name: 'get', arguments: '{}' },
  ])
})

test('foreign replay state is ignored', () => {
  const input = toResponsesInput([
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'APPLE' }],
      replayState: { response: { adapter: 'other' }, blocks: [{ type: 'reasoning', id: 'rs_1', status: 'completed' }] },
    },
  ])
  assert.deepEqual(input, [{ role: 'assistant', content: 'APPLE' }])
})

test('tool-result images survive as function_call_output content', () => {
  const input = toResponsesInput([
    { role: 'tool', tool_call_id: 'chatcmpl-tool-1', content: [{ type: 'text', text: 'shot' }, { type: 'image_url', image_url: { url: image } }] },
  ])
  assert.deepEqual(input, [
    {
      type: 'function_call_output',
      call_id: 'chatcmpl-tool-1',
      output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', detail: 'auto', image_url: image }],
    },
  ])
})

test('incomplete responses report max-tokens', () => {
  const chunk = responsesEventToChunk({ type: 'response.incomplete', response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } })
  assert.equal(chunk.choices[0].finish_reason, 'length')
  assert.equal(chunk.usage.prompt_tokens, 5)
})

test('argument deltas keep the call id from output_item.added', () => {
  const chunk = responsesEventToChunk({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' })
  assert.equal(chunk.choices[0].delta.tool_calls[0].id, undefined)
})

test('empty content becomes an empty string', () => {
  assert.equal(toResponsesContent(undefined), '')
  assert.equal(toResponsesContent([]), '')
})

test('usage reports uncached input separately from cache reads', () => {
  const usage = tokenUsageFromChat({
    prompt_tokens: 23490,
    completion_tokens: 252,
    total_tokens: 23742,
    prompt_tokens_details: { cached_tokens: 22400 },
  })
  assert.deepEqual(usage, {
    inputTokens: 1090,
    outputTokens: 252,
    totalTokens: 23742,
    cacheReadTokens: 22400,
  })
})
