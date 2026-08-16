/**
 * Sanitize Anthropic Messages body for api.anthropic.com OAuth path.
 * Claude CLI injects fields/betas that pure API may reject.
 */

const ALLOWED_TOP = new Set([
  'model', 'messages', 'max_tokens', 'system', 'temperature', 'top_p', 'top_k',
  'stop_sequences', 'stream', 'metadata', 'tools', 'tool_choice',
  // thinking often needs beta; keep only if type present and safe
])

export function sanitizeAnthropicBody(body, { strictPassthrough = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (strictPassthrough) return { ...body }

  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_TOP.has(k)) out[k] = v
  }

  // system: Claude CLI sends array of {type,text,...}; API accepts string or array of text blocks
  if (Array.isArray(out.system)) {
    const texts = out.system.map((b) => {
      if (typeof b === 'string') return b
      if (b && typeof b.text === 'string') return b.text
      return ''
    }).filter(Boolean)
    out.system = texts.length === 1 ? texts[0] : texts.map((t) => ({ type: 'text', text: t }))
  }

  // tools: empty array → omit (cleaner)
  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools

  // Cap absurd max_tokens from CLI
  if (typeof out.max_tokens === 'number' && out.max_tokens > 8192) {
    out.max_tokens = 8192
  }
  if (!out.max_tokens) out.max_tokens = 4096

  // Strip tool_choice if no tools
  if (out.tool_choice && !out.tools) delete out.tool_choice

  return out
}
