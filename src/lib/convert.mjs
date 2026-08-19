/**
 * Protocol conversion — passthrough-first.
 * Tools: OpenAI function tools ↔ Claude tools
 * Streaming: Claude SSE events → OpenAI Chat chunks / Responses events
 */

import { sanitizeAnthropicBody } from './sanitize.mjs'
import { openaiReasoningToClaudeThinking, claudeThinkingToOpenAIReasoning } from './thinking.mjs'
import { openaiContentToClaudeContent } from './images.mjs'
import { remapCodexTools } from './codex-tools.mjs'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

/** No aliases. Model must already be an official Claude id (validated upstream). */
export function mapModel(m, { allowMap = false } = {}) {
  const s = String(m || '').trim()
  if (!s) return DEFAULT_MODEL
  // Never remap third-party names
  return s
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p
      if (p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text') return p.text || ''
      return ''
    }).filter(Boolean).join('\n')
  }
  return content?.text || ''
}

export function isClaudeMessagesShape(body) {
  return !!(
    body &&
    typeof body === 'object' &&
    Array.isArray(body.messages) &&
    typeof body.max_tokens === 'number' &&
    !('input' in body) &&
    !('choices' in body)
  )
}

/** OpenAI tools → Claude tools */
export function openaiToolsToClaude(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  return remapCodexTools(tools)
    .filter((t) => t && (t.type === 'function' || t.function || t.name))
    .map((t) => {
      if (t.type === 'function' && t.function) {
        return {
          name: t.function.name,
          description: t.function.description || '',
          input_schema: t.function.parameters || { type: 'object', properties: {} },
        }
      }
      // already Claude-ish
      if (t.name && t.input_schema) return t
      return {
        name: t.name || t.function?.name,
        description: t.description || '',
        input_schema: t.input_schema || t.parameters || { type: 'object', properties: {} },
      }
    })
    .filter((t) => t.name)
}

/** OpenAI tool_choice → Claude */
export function openaiToolChoiceToClaude(toolChoice) {
  if (toolChoice == null) return undefined
  if (toolChoice === 'auto') return { type: 'auto' }
  if (toolChoice === 'none') return { type: 'none' }
  if (toolChoice === 'required') return { type: 'any' }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'tool', name: toolChoice.function?.name || toolChoice.name }
  }
  return undefined
}

/** Convert OpenAI-style messages including tool / tool_calls to Claude blocks */
function openaiMessagesToClaude(messages) {
  const systemParts = []
  const out = []

  for (const m of messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = contentToText(m.content)
      if (text) systemParts.push(text)
      continue
    }

    if (m.role === 'tool') {
      // tool result
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.id || 'tool_unknown',
        content: contentToText(m.content),
      }
      // append to last user message or create user message
      if (out.length && out[out.length - 1].role === 'user' && Array.isArray(out[out.length - 1].content)) {
        out[out.length - 1].content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (m.role === 'assistant') {
      const content = []
      const text = contentToText(m.content)
      if (text) content.push({ type: 'text', text })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let input = {}
          try {
            input = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : (tc.function?.arguments || {})
          } catch {
            input = { raw: tc.function?.arguments }
          }
          content.push({
            type: 'tool_use',
            id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.function?.name || tc.name,
            input,
          })
        }
      }
      if (!content.length) content.push({ type: 'text', text: '' })
      out.push({ role: 'assistant', content })
      continue
    }

    // user (text + optional images)
    const content = openaiContentToClaudeContent(m.content)
    const role = 'user'
    if (
      out.length &&
      out[out.length - 1].role === role &&
      typeof out[out.length - 1].content === 'string' &&
      typeof content === 'string'
    ) {
      out[out.length - 1].content += '\n' + content
    } else {
      out.push({ role, content })
    }
  }

  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '' })
  }
  return { systemParts, messages: out }
}

export function toClaudeMessages(protocol, body, opts = { rewrite: false, model_map: true }) {
  if (protocol === 'anthropic.messages' && !opts.rewrite) {
    const out = sanitizeAnthropicBody(body, { strictPassthrough: opts.strict_passthrough })
    if (!out.max_tokens) out.max_tokens = 4096
    return { claude: out, mode: 'passthrough' }
  }

  if (protocol === 'anthropic.messages' && opts.rewrite) {
    return {
      claude: {
        ...body,
        model: mapModel(body.model || DEFAULT_MODEL, { allowMap: opts.model_map }),
        max_tokens: body.max_tokens || 1024,
      },
      mode: 'rewrite',
    }
  }

  if (protocol === 'openai.chat') {
    return { claude: openaiToClaude(body, opts), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  if (protocol === 'openai.completions') {
    return { claude: completionsToClaude(body, opts), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  if (protocol === 'openai.responses') {
    return { claude: responsesToClaude(body, opts), mode: opts.rewrite ? 'rewrite' : 'convert' }
  }
  throw new Error(`unsupported protocol: ${protocol}`)
}

function openaiToClaude(body, opts) {
  const { systemParts, messages } = openaiMessagesToClaude(body.messages || [])
  const out = {
    model: mapModel(body.model, { allowMap: opts.model_map !== false }),
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop_sequences = body.stop_sequences
  const tools = openaiToolsToClaude(body.tools)
  if (tools?.length) out.tools = tools
  const tc = openaiToolChoiceToClaude(body.tool_choice)
  if (tc) out.tool_choice = tc
  const thinking = openaiReasoningToClaudeThinking(body)
  if (thinking) out.thinking = thinking
  return out
}

/** Legacy OpenAI /v1/completions (prompt, not messages). */
function completionsToClaude(body, opts) {
  const prompt = Array.isArray(body.prompt)
    ? body.prompt.map((p) => (typeof p === 'string' ? p : String(p ?? ''))).join('\n')
    : (body.prompt == null ? '' : String(body.prompt))
  const suffix = body.suffix ? String(body.suffix) : ''
  const user = suffix ? `${prompt}${suffix}` : prompt
  return openaiToClaude({
    ...body,
    messages: [{ role: 'user', content: user || 'Hello' }],
  }, opts)
}

function responsesToClaude(body, opts) {
  const systemParts = []
  const messages = []
  if (body.instructions) systemParts.push(String(body.instructions))
  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
        continue
      }
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user'
      const text = contentToText(item.content ?? item.text ?? item)
      if (role === 'system') {
        if (text) systemParts.push(text)
      } else if (messages.length && messages[messages.length - 1].role === role && typeof messages[messages.length - 1].content === 'string') {
        messages[messages.length - 1].content += '\n' + text
      } else {
        messages.push({ role, content: text })
      }
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: '' })
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: '' })
  const out = {
    model: mapModel(body.model, { allowMap: opts.model_map !== false }),
    max_tokens: body.max_output_tokens || body.max_tokens || 1024,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  const tools = openaiToolsToClaude(body.tools)
  if (tools?.length) out.tools = tools
  const thinking = openaiReasoningToClaudeThinking(body)
  if (thinking) out.thinking = thinking
  return out
}

export function fromClaudeToOpenAIChat(claude, requestedModel, vmId, mode = 'convert') {
  const textParts = []
  const toolCalls = []
  for (const b of claude.content || []) {
    if (b.type === 'text') textParts.push(b.text || '')
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input || {}),
        },
      })
    }
  }
  const message = { role: 'assistant', content: textParts.join('') || null }
  const reasoning = claudeThinkingToOpenAIReasoning(claude)
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) {
    message.tool_calls = toolCalls
    if (!textParts.length) message.content = null
  }
  let finish = 'stop'
  if (claude.stop_reason === 'tool_use') finish = 'tool_calls'
  else if (claude.stop_reason === 'max_tokens') finish = 'length'
  else if (claude.stop_reason === 'end_turn') finish = 'stop'

  return {
    id: 'chatcmpl-' + (claude.id || 'kin'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || claude.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: claude.usage?.input_tokens || 0,
      completion_tokens: claude.usage?.output_tokens || 0,
      total_tokens: (claude.usage?.input_tokens || 0) + (claude.usage?.output_tokens || 0),
    },
  }
}

export function fromClaudeToResponses(claude, requestedModel, vmId, mode = 'convert') {
  const text = (claude.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
  const output = [{
    type: 'message',
    id: 'msg_' + Math.random().toString(16).slice(2, 8),
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }]
  for (const b of claude.content || []) {
    if (b.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input || {}),
      })
    }
  }
  return {
    id: 'resp_' + Math.random().toString(16).slice(2, 10),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestedModel || claude.model,
    output,
    output_text: text,
    usage: {
      input_tokens: claude.usage?.input_tokens || 0,
      output_tokens: claude.usage?.output_tokens || 0,
      total_tokens: (claude.usage?.input_tokens || 0) + (claude.usage?.output_tokens || 0),
    },
  }
}

// ---------- Streaming: Claude SSE → OpenAI Chat chunks ----------
export function createOpenAIChatStreamState(model, vmId) {
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2, 12),
    model,
    vmId,
    toolIndex: 0,
    toolMap: new Map(), // block index → tool call index
    sentRole: false,
  }
}

export function claudeSSELineToOpenAIChatChunks(line, state) {
  if (!line.startsWith('data:')) return []
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return []
  let evt
  try { evt = JSON.parse(payload) } catch { return [] }

  const chunks = []
  const base = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
  }

  if (evt.type === 'message_start') {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })
    state.sentRole = true
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    const idx = state.toolIndex++
    state.toolMap.set(evt.index, idx)
    chunks.push({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: idx,
            id: evt.content_block.id,
            type: 'function',
            function: { name: evt.content_block.name, arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    })
  }

  if (evt.type === 'content_block_start' && (evt.content_block?.type === 'thinking' || evt.content_block?.type === 'redacted_thinking')) {
    // OpenAI-compat: announce reasoning channel
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: '' }, finish_reason: null }],
    })
  }

  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta') {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { content: evt.delta.text || '' }, finish_reason: null }],
      })
    }
    // Claude thinking → OpenAI-compat reasoning_content (原样文本)
    if (evt.delta?.type === 'thinking_delta') {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: evt.delta.thinking || '' }, finish_reason: null }],
      })
    }
    // signature kept as opaque delta for clients that want full fidelity
    if (evt.delta?.type === 'signature_delta' && evt.delta.signature) {
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_signature: evt.delta.signature }, finish_reason: null }],
      })
    }
    if (evt.delta?.type === 'input_json_delta') {
      const idx = state.toolMap.get(evt.index) ?? 0
      chunks.push({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: idx, function: { arguments: evt.delta.partial_json || '' } }] },
          finish_reason: null,
        }],
      })
    }
  }

  if (evt.type === 'message_delta') {
    let finish = 'stop'
    const sr = evt.delta?.stop_reason
    if (sr === 'tool_use') finish = 'tool_calls'
    else if (sr === 'max_tokens') finish = 'length'
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: evt.usage ? {
        prompt_tokens: evt.usage.input_tokens || 0,
        completion_tokens: evt.usage.output_tokens || 0,
        total_tokens: (evt.usage.input_tokens || 0) + (evt.usage.output_tokens || 0),
      } : undefined,
    })
  }

  return chunks
}

// ---------- Streaming: Claude SSE → OpenAI Responses-like events ----------
export function createResponsesStreamState(model, vmId) {
  return {
    id: 'resp_' + Math.random().toString(36).slice(2, 10),
    model,
    vmId,
    text: '',
  }
}

export function claudeSSELineToResponsesEvents(line, state) {
  if (!line.startsWith('data:')) return []
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return []
  let evt
  try { evt = JSON.parse(payload) } catch { return [] }
  const out = []

  if (evt.type === 'message_start') {
    state.outputIndex = 0
    state.contentIndex = 0
    state.itemId = 'msg_' + Math.random().toString(36).slice(2, 10)
    out.push({
      type: 'response.created',
      response: { id: state.id, object: 'response', model: state.model, status: 'in_progress' },
    })
    out.push({ type: 'response.in_progress', response: { id: state.id, status: 'in_progress' } })
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'text') {
    out.push({
      type: 'response.output_item.added',
      output_index: state.outputIndex || 0,
      item: {
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        content: [],
        status: 'in_progress',
      },
    })
    out.push({
      type: 'response.content_part.added',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      part: { type: 'output_text', text: '' },
    })
  }

  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    state.text += evt.delta.text || ''
    out.push({
      type: 'response.output_text.delta',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      delta: evt.delta.text || '',
    })
  }

  if (evt.type === 'content_block_stop') {
    out.push({
      type: 'response.output_text.done',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      text: state.text,
    })
    out.push({
      type: 'response.content_part.done',
      output_index: state.outputIndex || 0,
      content_index: state.contentIndex || 0,
      part: { type: 'output_text', text: state.text },
    })
    out.push({
      type: 'response.output_item.done',
      output_index: state.outputIndex || 0,
      item: {
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        content: [{ type: 'output_text', text: state.text }],
        status: 'completed',
      },
    })
  }

  if (evt.type === 'message_stop') {
    out.push({
      type: 'response.completed',
      response: {
        id: state.id,
        object: 'response',
        model: state.model,
        status: 'completed',
        output: [{
          type: 'message',
          id: state.itemId,
          role: 'assistant',
          content: [{ type: 'output_text', text: state.text }],
        }],
        output_text: state.text,
      },
    })
  }
  return out
}

export function fromClaudeToOpenAICompletions(claude, requestedModel) {
  const text = (claude.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
  let finish = 'stop'
  if (claude.stop_reason === 'max_tokens') finish = 'length'
  else if (claude.stop_reason === 'stop_sequence') finish = 'stop'
  return {
    id: 'cmpl-' + (claude.id || 'kin'),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || claude.model,
    choices: [{ text, index: 0, finish_reason: finish, logprobs: null }],
    usage: {
      prompt_tokens: claude.usage?.input_tokens || 0,
      completion_tokens: claude.usage?.output_tokens || 0,
      total_tokens: (claude.usage?.input_tokens || 0) + (claude.usage?.output_tokens || 0),
    },
  }
}

export function createOpenAICompletionStreamState(model, vmId) {
  return {
    id: 'cmpl-' + Math.random().toString(36).slice(2, 12),
    model,
    vmId,
    chat: createOpenAIChatStreamState(model, vmId),
  }
}

export function claudeSSELineToOpenAICompletionChunks(line, state) {
  const chats = claudeSSELineToOpenAIChatChunks(line, state.chat)
  return chats.map((c) => ({
    id: state.id,
    object: 'text_completion',
    created: c.created,
    model: state.model,
    choices: [{
      text: c.choices?.[0]?.delta?.content || '',
      index: 0,
      finish_reason: c.choices?.[0]?.finish_reason ?? null,
      logprobs: null,
    }],
  })).filter((c) => c.choices[0].text || c.choices[0].finish_reason)
}

