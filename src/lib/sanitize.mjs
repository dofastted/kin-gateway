/**
 * Sanitize Anthropic Messages body for official API (CRS-style allowlist).
 * Official Claude Code fields stay; junk / client-private keys drop.
 */
const ALLOWED_TOP = new Set([
  'model', 'messages', 'max_tokens', 'system', 'temperature', 'top_p', 'top_k',
  'stop_sequences', 'stop', 'stream', 'metadata', 'tools', 'tool_choice',
  'thinking', 'context_management',
])

export function sanitizeAnthropicBody(body, { strictPassthrough = false } = {}) {
  if (!body || typeof body !== 'object') return body
  if (strictPassthrough) {
    const out = { ...body }
    normalizeStop(out)
    return out
  }

  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_TOP.has(k)) out[k] = v
  }

  if (Array.isArray(out.system)) {
    const blocks = out.system
      .map((b) => {
        if (typeof b === 'string') return { type: 'text', text: b }
        if (b && typeof b.text === 'string') {
          const block = { type: 'text', text: b.text }
          if (b.cache_control) block.cache_control = b.cache_control
          return block
        }
        return null
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
