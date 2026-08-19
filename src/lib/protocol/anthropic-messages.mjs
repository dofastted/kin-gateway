/**
 * Official Messages body shaping only.
 * The HTTP hop lives in the per-slot Go worker. This file only sanitizes the body.
 */
const ALLOWED_BODY = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stop',
  'tools',
  'tool_choice',
  'metadata',
  'thinking',
  'context_management',
])

export function officialMessagesBody(body = {}, { stream = undefined } = {}) {
  const out = {}
  for (const [k, v] of Object.entries(body || {})) {
    if (ALLOWED_BODY.has(k) && v !== undefined) out[k] = v
  }
  if (stream !== undefined) out.stream = !!stream
  if (!out.max_tokens) out.max_tokens = 8192
  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  if (out.tool_choice && !out.tools) delete out.tool_choice
  return out
}

const DISABLED = {
  status: 501,
  ok: false,
  via: 'anthropic-messages-disabled',
  body: {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Direct host HTTP hop is disabled. All Anthropic I/O goes through the Go slot worker.',
    },
  },
  headers: {},
}

/** Host-process hop stays disabled. The Go slot worker owns the Anthropic HTTP hop. */
export async function callAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}

export async function streamAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}
