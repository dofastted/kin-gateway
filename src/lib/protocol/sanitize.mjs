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

  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  if (typeof out.max_tokens === 'number' && out.max_tokens > 64000) out.max_tokens = 64000
  if (!out.max_tokens) out.max_tokens = 4096
  if (out.tool_choice && !out.tools) delete out.tool_choice
  normalizeStop(out)
  return out
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
