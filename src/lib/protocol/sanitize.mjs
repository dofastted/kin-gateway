/**
 * Sanitize Anthropic Messages body for official API.
 *
 * Credential-forwarding (sub2api-style): drop client-private / OpenAI leftover
 * keys, pass through unknown official fields such as output_config.
 */
const DROP_TOP = new Set([
  'settings',
  'claude_settings',
  'env',
  'user',
  'user_id',
  'extra_body',
  'extra_headers',
  'extra',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'functions',
  'function_call',
  'response_format',
  'seed',
  'parallel_tool_calls',
  'reasoning_effort',
  'max_completion_tokens',
  'max_output_tokens',
  'store',
  'modalities',
  'audio',
  'prediction',
  'stream_options',
  'tool_resources',
  'instructions',
  'input',
  'truncation',
  'include',
  'previous_response_id',
  'reasoning',
  'prompt',
  'suffix',
  'best_of',
  'echo',
  'workspace',
  'rewrite',
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'functionCall',
  'responseFormat',
  'maxCompletionTokens',
  'parallelToolCalls',
  'toolResources',
  'streamOptions',
  'previousResponseId',
  'reasoningEffort',
  'session',
  'machine_id',
  'device_id',
  'account_uuid',
])

/** Copy official Anthropic fields; drop client junk / OpenAI leftovers. */
export function copyOfficialAnthropicFields(body) {
  const out = {}
  for (const [k, v] of Object.entries(body || {})) {
    if (v === undefined) continue
    if (DROP_TOP.has(k)) continue
    out[k] = v
  }
  return out
}

export function sanitizeAnthropicBody(body, { strictPassthrough = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (strictPassthrough) {
    const out = { ...body }
    normalizeStop(out)
    return out
  }

  const out = copyOfficialAnthropicFields(body)

  if (Array.isArray(out.system)) {
    const blocks = out.system
      .map((b) => {
        if (typeof b === 'string') return { type: 'text', text: b }
        if (b && typeof b.text === 'string') {
          const block = { type: 'text', text: b.text }
          if (b.cache_control) block.cache_control = b.cache_control
          return block
        }
        return b && typeof b === 'object' ? b : null
      })
      .filter(Boolean)
    out.system = blocks
  }

  normalizeAnthropicMessages(out)

  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  if (typeof out.max_tokens === 'number' && out.max_tokens > 64000) out.max_tokens = 64000
  if (!out.max_tokens) out.max_tokens = 4096
  if (out.tool_choice && !out.tools) delete out.tool_choice
  normalizeStop(out)
  return out
}

/**
 * Sub2API-style Messages repair before the Anthropic hop:
 *   - system / developer turns lift into the top-level system field
 *   - unknown roles (admin, tool, function, …) become user
 *   - empty content is dropped
 *   - consecutive same-role turns are merged (Anthropic requires alternation)
 *   - the first remaining turn must be user
 */
export function normalizeAnthropicMessages(body) {
  if (!body || !Array.isArray(body.messages)) return body

  const systemParts = []
  const mapped = []
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue
    const role = String(message.role || '').trim().toLowerCase()
    if (role === 'system' || role === 'developer') {
      const text = contentToPlainText(message.content)
      if (text) systemParts.push(text)
      continue
    }
    if (anthropicContentIsEmpty(message.content)) continue
    mapped.push({
      ...message,
      role: role === 'assistant' ? 'assistant' : 'user',
    })
  }

  const merged = mergeConsecutiveAnthropicMessages(mapped)
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '.' })
  }

  body.messages = merged
  if (systemParts.length) body.system = appendSystemParts(body.system, systemParts)
  return body
}

function contentToPlainText(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
        return part.text || ''
      }
      return ''
    }).filter((text) => String(text).trim()).join('\n').trim()
  }
  return String(content?.text || '').trim()
}

function anthropicContentIsEmpty(content) {
  if (content == null) return true
  if (typeof content === 'string') return !content.trim()
  if (!Array.isArray(content)) return false
  if (!content.length) return true
  return content.every((block) => {
    if (typeof block === 'string') return !block.trim()
    if (!block || typeof block !== 'object') return true
    if (block.type === 'text' || block.type == null) return !String(block.text || '').trim()
    return false
  })
}

function mergeConsecutiveAnthropicMessages(messages) {
  const out = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (!last || last.role !== message.role) {
      out.push({ ...message })
      continue
    }
    last.content = mergeAnthropicContent(last.content, message.content)
  }
  return out
}

function mergeAnthropicContent(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n${right}`
  return [...asContentBlocks(left), ...asContentBlocks(right)]
}

function asContentBlocks(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

function appendSystemParts(existing, parts) {
  const extra = parts.filter(Boolean)
  if (!extra.length) return existing
  const joined = extra.join('\n\n')
  if (existing == null || existing === '') return joined
  if (typeof existing === 'string') return `${existing}\n\n${joined}`
  if (Array.isArray(existing)) {
    return [...existing, ...extra.map((text) => ({ type: 'text', text }))]
  }
  return existing
}

function normalizeStop(out) {
  if (out.stop_sequences) {
    delete out.stop
    return
  }
  if (out.stop == null) return
  out.stop_sequences = Array.isArray(out.stop) ? out.stop : [out.stop]
  delete out.stop
}
