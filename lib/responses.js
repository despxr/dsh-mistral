/**
 * Pure request/stream shapes for Mistral's stateless Responses API.
 *
 * The adapter keeps one internal message shape (Chat Completions) while the
 * wire protocol is selected per call. Everything that differs between the two
 * wires lives here so it can be tested without booting a dsh profile.
 *
 * Responses content parts are `input_text` / `input_image` with a string URL.
 * Chat Completions parts (`text` / `image_url` with an object URL) are rejected
 * by `/v1/responses` with `400 input.str: Input should be a valid string`.
 */

/** Convert one chat-shaped content value into a Responses input content value. */
export function toResponsesContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? '' : String(content)
  }
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text })
    } else if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url !== '') {
        parts.push({ type: 'input_image', detail: 'auto', image_url: url })
      }
    }
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'input_text') return parts[0].text
  return parts
}

/** Extract the assistant text that Responses replays as a plain assistant message. */
export function assistantText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Build the `input` array for one Responses request.
 *
 * @param messages - adapter messages. User/tool content is chat-shaped;
 *   assistant content is dsh content blocks and may carry `replayState` from a
 *   previous Responses stream, whose per-block entries are replayed verbatim as
 *   reasoning items.
 * @returns Responses input items.
 */
export function toResponsesInput(messages) {
  const input = []
  for (const message of messages ?? []) {
    if (message.role === 'system') {
      input.push({ role: 'system', content: toResponsesContent(message.content) })
      continue
    }
    if (message.role === 'user') {
      input.push({ role: 'user', content: toResponsesContent(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      const replayState = message.replayState
      const replayBlocks =
        replayState?.response?.adapter === 'dsh-mistral' && Array.isArray(replayState.blocks)
          ? replayState.blocks
          : []
      let blockIndex = 0
      let toolCallsFromBlocks = false
      for (const block of blocks) {
        if (block?.type === 'reasoning') {
          const item = replayBlocks[blockIndex]
          if (item !== null && typeof item === 'object' && item.type === 'reasoning' && item.status === 'completed') {
            input.push(item)
          }
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          input.push({ role: 'assistant', content: block.text })
        } else if (block?.type === 'tool-call') {
          toolCallsFromBlocks = true
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name ?? '',
            arguments: block.arguments ?? '{}',
          })
        }
        blockIndex++
      }
      if (blocks.length === 0) {
        const text = assistantText(message.content)
        if (text !== '') input.push({ role: 'assistant', content: text })
      }
      if (!toolCallsFromBlocks) {
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '{}',
          })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: toResponsesContent(message.content),
      })
    }
  }
  return input
}

function usageOf(usage) {
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
  }
}

/**
 * Normalize a Chat-Completions-shaped usage object for dsh's token meter.
 *
 * dsh treats `inputTokens` as the *uncached* input count and adds
 * `cacheReadTokens` separately. Mistral's `prompt_tokens` is the full prompt
 * count, cached tokens included, so subtract the cached subset here. Reporting
 * the total instead makes the meter count cached tokens twice and halves the
 * displayed cache-hit rate.
 */
export function tokenUsageFromChat(usage) {
  const prompt = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0
  const cached = Number.isFinite(usage?.prompt_tokens_details?.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens
    : 0
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0,
    totalTokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : 0,
    cacheReadTokens: Math.max(0, cached),
  }
}

/**
 * Translate one Mistral Responses SSE event into a Chat Completions chunk.
 *
 * The Responses stream is item-oriented: text arrives as
 * `response.output_text.delta`, tool calls as
 * `response.function_call_arguments.delta` plus an `item.added` carrying the
 * name and call id. Folding both into the chat shape lets the existing sink
 * accumulate blocks without a second code path.
 *
 * @param event - one parsed SSE payload.
 * @returns a chat-shaped chunk, or undefined when the event carries nothing.
 */
export function responsesEventToChunk(event) {
  const type = typeof event?.type === 'string' ? event.type : ''

  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    return { choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] }
  }

  if (type === 'response.reasoning_text.delta' && typeof event.delta === 'string') {
    return { choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] }
  }

  if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
    return {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: Number.isInteger(event.output_index) ? event.output_index : 0,
                id: event.item.call_id,
                type: 'function',
                function: { name: event.item.name ?? '', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
  }

  if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
    return {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: Number.isInteger(event.output_index) ? event.output_index : 0,
                // Keep the call id from `output_item.added`; `item_id` is the
                // provider item id (`fc_...`), not the id the tool result must
                // answer (`chatcmpl-tool-...`).
                type: 'function',
                function: { name: '', arguments: event.delta },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const usage = event.response?.usage
    const chunk = {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: type === 'response.incomplete' ? 'length' : 'stop',
        },
      ],
    }
    if (usage && typeof usage === 'object') chunk.usage = usageOf(usage)
    return chunk
  }

  return undefined
}
