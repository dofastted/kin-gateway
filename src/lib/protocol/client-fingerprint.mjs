/**
 * Client classification for inbound requests.
 * Used for logging/audit and the unofficial-persona policy — never to
 * impersonate a client or rewrite HTTP headers.
 */

export function fingerprintRequest(req, body) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers || {})) {
    const key = k.toLowerCase()
    if (key === 'authorization' || key === 'x-api-key') {
      headers[key] = String(v).slice(0, 12) + '…'
    } else {
      headers[key] = v
    }
  }
  return {
    method: req.method,
    path: req.url,
    headers,
    body_keys: body && typeof body === 'object' ? Object.keys(body) : [],
    body_preview: summarizeBody(body),
    client_class: classifyClient(headers, body),
  }
}

export function classifyClient(headers, body) {
  const ua = String(headers['user-agent'] || '')
  const xapp = String(headers['x-app'] || '')
  const blob = systemBlob(body)
  if (/claude-cli|claude-code/i.test(ua) || xapp === 'cli') return 'claude_code_official'
  if (/hermes-agent|hermes\//i.test(ua) || /you are hermes|nous research/i.test(blob)) return 'hermes'
  if (/openclaw|clawdbot|moltbot/i.test(ua) || /inside openclaw|running inside openclaw/i.test(blob)) return 'openclaw'
  if (/pi\b|pi-coding/i.test(ua) || /operating inside pi/i.test(blob)) return 'third_party'
  if (/codex|openai/i.test(ua) || /codex cli/i.test(blob)) return 'third_party'
  if (/axios|got\b|node-fetch|undici/i.test(ua)) return 'third_party'
  if (headers['x-stainless-package-version'] && /claude-cli/i.test(ua)) return 'claude_code_official'
  if (headers['anthropic-beta'] && !/claude-cli/i.test(ua)) return 'third_party_sdk'
  return 'unknown'
}

function systemBlob(body) {
  if (!body || typeof body !== 'object') return ''
  const parts = []
  if (typeof body.system === 'string') parts.push(body.system)
  else if (Array.isArray(body.system)) {
    for (const b of body.system) parts.push(typeof b === 'string' ? b : b?.text || '')
  }
  if (typeof body.instructions === 'string') parts.push(body.instructions)
  return parts.join('\n').slice(0, 4000)
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return body
  return {
    model: body.model,
    stream: !!body.stream,
    max_tokens: body.max_tokens,
    has_system: body.system != null,
    system_type: Array.isArray(body.system) ? 'array' : typeof body.system,
    messages_count: Array.isArray(body.messages) ? body.messages.length : 0,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    has_thinking: body.thinking != null,
    has_context_management: body.context_management != null,
    has_metadata: body.metadata != null,
    has_output_config: body.output_config != null,
    top_level_keys: Object.keys(body).sort(),
  }
}
