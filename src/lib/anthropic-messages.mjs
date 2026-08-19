/**
 * Official Messages body shaping only.
 * HTTP hop lives in crs-relay.mjs (VM UID). This file only sanitizes the body.
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
      message: 'Direct host HTTP hop is disabled. Use crs-relay (VM UID) or CLI fallback.',
    },
  },
  headers: {},
}

/** Host-process hop stays disabled. CRS uses crs-relay.mjs as uid worker. */
export async function callAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}

export async function streamAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}
