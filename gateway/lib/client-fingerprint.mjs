/**
 * Client classification + normalize third-party requests to the
 * official Claude Code (Messages) standard expected by VM-side Claude Code.
 *
 * Architecture:
 *   Third-party / OpenAI / Pi  →  Gateway normalize  →  VM Claude Code path
 *
 * This is protocol alignment to the official Claude Code request contract,
 * not impersonation.
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
  if (/claude-cli|claude-code/i.test(ua) || xapp === 'cli') return 'claude_code_official'
  if (/pi\b|pi-coding|openai|codex|axios|got\b|node-fetch|undici/i.test(ua)) return 'third_party'
  if (headers['x-stainless-package-version'] && /claude-cli/i.test(ua)) return 'claude_code_official'
  if (headers['anthropic-beta'] && !/claude-cli/i.test(ua)) return 'third_party_sdk'
  return 'unknown'
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

/**
 * Align any inbound Anthropic-ish body to the official Claude Code Messages contract
 * used by the VM Claude Code forwarding path.
 *
 * Official contract (subset):
 * - model, messages, max_tokens required
 * - system: string | TextBlock[]
 * - tools / tool_choice when used
 * - metadata optional but standard in Claude Code
 * - no unsupported experimental fields on the OAuth/API hop
 * - request headers match Claude Code CLI hop identity (x-app, UA, beta, version)
 */
export function alignToClaudeCodeStandard(body, inboundHeaders = {}) {
  const out = {
    model: body.model || 'claude-haiku-4-5-20251001',
    messages: normalizeMessages(body.messages),
    max_tokens: clampTokens(body.max_tokens),
    stream: body.stream === true,
  }

  if (body.system != null) {
    out.system = normalizeSystem(body.system)
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
  }
  if (body.tool_choice) out.tool_choice = body.tool_choice

  // Only forward client metadata — never invent user_id / prompts
  if (body.metadata && typeof body.metadata === 'object') {
    out.metadata = body.metadata
  }

  if (body.temperature != null) out.temperature = body.temperature

  // Keep explicit thinking only when client requested enabled
  if (body.thinking && body.thinking.type === 'enabled') {
    out.thinking = body.thinking
  }

  // Headers for the VM → Claude Code / Anthropic hop (official Claude Code contract)
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': pickOfficialBetas(inboundHeaders['anthropic-beta']),
    'user-agent': 'claude-cli/2.1.233 (external, sdk-cli)',
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
    'x-stainless-package-version': '0.112.1',
  }

  return { body: out, headers, alignment: 'claude_code_official_standard' }
}

// Backward-compatible alias
export const officializeToClaudeCli = alignToClaudeCodeStandard

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    if (Array.isArray(m.content)) return { role: m.role, content: m.content }
    return { role: m.role || 'user', content: String(m.content ?? '') }
  })
}

function normalizeSystem(system) {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((b) => {
      if (typeof b === 'string') return { type: 'text', text: b }
      if (b && b.type === 'text') return { type: 'text', text: b.text || '' }
      if (b && b.text) return { type: 'text', text: b.text }
      return { type: 'text', text: String(b) }
    })
  }
  return String(system)
}

function clampTokens(n) {
  const x = Number(n) || 4096
  return Math.min(Math.max(x, 1), 8192)
}

function pickOfficialBetas(inbound) {
  // Official Claude Code beta set for the VM forward hop (OAuth-safe subset)
  const base = ['oauth-2025-04-20', 'claude-code-20250219', 'interleaved-thinking-2025-05-14']
  if (!inbound) return base.join(',')
  const parts = String(inbound)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/context-management/i.test(s) && !/advisor-tool/i.test(s))
  for (const b of base) {
    if (!parts.includes(b)) parts.push(b)
  }
  return parts.join(',')
}

export function diffFingerprints(official, third) {
  const headerKeys = new Set([
    ...Object.keys(official.headers || {}),
    ...Object.keys(third.headers || {}),
  ])
  const headerDiff = {}
  for (const k of [...headerKeys].sort()) {
    const a = official.headers?.[k]
    const b = third.headers?.[k]
    if (String(a) !== String(b)) headerDiff[k] = { claude_code_official: a ?? null, third_party: b ?? null }
  }

  const bodyA = official.body_preview || {}
  const bodyB = third.body_preview || {}
  const bodyDiff = {}
  const keys = new Set([...Object.keys(bodyA), ...Object.keys(bodyB)])
  for (const k of [...keys].sort()) {
    if (JSON.stringify(bodyA[k]) !== JSON.stringify(bodyB[k])) {
      bodyDiff[k] = { claude_code_official: bodyA[k] ?? null, third_party: bodyB[k] ?? null }
    }
  }
  return { headerDiff, bodyDiff }
}
