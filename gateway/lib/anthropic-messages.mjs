/**
 * Official Messages body shaping only.
 * HARD RULE: never use VM OAuth to call api.anthropic.com.
 */
const ALLOWED_BODY = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "stop",
  "tools",
  "tool_choice",
  "metadata",
  "thinking",
  "context_management",
])

export function officialMessagesBody(body = {}, { stream = undefined } = {}) {
  const out = {}
  for (const [k, v] of Object.entries(body || {})) {
    if (ALLOWED_BODY.has(k) && v !== undefined) out[k] = v
  }
  if (stream !== undefined) out.stream = !!stream
  if (!out.max_tokens) out.max_tokens = 8192
  if (out.temperature == null) out.temperature = 1
  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  if (out.tool_choice && !out.tools) delete out.tool_choice
  return out
}

const DISABLED = {
  status: 501,
  ok: false,
  via: "anthropic-messages-disabled",
  body: {
    type: "error",
    error: {
      type: "api_error",
      message: "HTTP Anthropic hop is disabled. Use VM official Claude CLI only. OAuth must not call api.anthropic.com.",
    },
  },
  headers: {},
}

/** Permanently disabled — kept so tests assert the hard rule. */
export async function callAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}

/** Permanently disabled — kept so tests assert the hard rule. */
export async function streamAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}
