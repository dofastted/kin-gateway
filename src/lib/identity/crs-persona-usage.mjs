/**
 * Client-facing usage rewrite for unofficial persona injection.
 * Official 3-block tokens stay visible as cache_creation / cache_read
 * (Claude Code shape). They are removed from input_tokens only.
 * Upstream / logs keep real Anthropic counts.
 */
import { CRS_OFFICIAL_SYSTEM, CRS_SYSTEM_EXPANSION } from './crs-persona.mjs'

/** Calibrated so rewrite 3-block (~1668 chars) ≥ observed short-request 554. */
export const PERSONA_TOKEN_CHAR_DIVISOR = 3

export function estimateClaudeInputTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  return Math.ceil(s.length / PERSONA_TOKEN_CHAR_DIVISOR)
}

function extractSystemTexts(system) {
  if (!system) return []
  if (typeof system === 'string') return [system]
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter((t) => String(t).trim())
  }
  if (typeof system === 'object' && typeof system.text === 'string') return [system.text]
  return []
}

function isOfficialPersonaText(text) {
  const t = String(text || '')
  if (/^\s*x-anthropic-billing-header:/i.test(t)) return true
  if (t.trim() === CRS_OFFICIAL_SYSTEM) return true
  if (t === CRS_SYSTEM_EXPANSION) return true
  return false
}

export function officialPersonaText(system) {
  const out = []
  for (const t of extractSystemTexts(system)) {
    if (isOfficialPersonaText(t)) {
      out.push(t)
      continue
    }
    if (!t.includes(CRS_OFFICIAL_SYSTEM)) continue
    const billing = t.match(/x-anthropic-billing-header:[^\n]*/i)
    if (billing) out.push(billing[0])
    out.push(CRS_OFFICIAL_SYSTEM)
    if (t.includes(CRS_SYSTEM_EXPANSION)) out.push(CRS_SYSTEM_EXPANSION)
  }
  return out.join('')
}

/** Tokens to subtract from client usage. 0 when we did not inject official blocks. */
export function personaHideInputTokens(before, after) {
  if (!after || before === after) return 0
  const afterOfficial = officialPersonaText(after.system)
  if (!afterOfficial) return 0
  const beforeOfficial = officialPersonaText(before?.system)
  if (afterOfficial === beforeOfficial) return 0
  return estimateClaudeInputTokens(afterOfficial)
}

function num(value) {
  return Number(value) || 0
}

function addTokens(obj, key, amount) {
  if (amount <= 0) return
  obj[key] = num(obj[key]) + amount
}

export function hidePersonaUsage(usage, hideTokens = 0, cacheTtl = '5m') {
  if (!usage || typeof usage !== 'object') return usage
  const hide = Math.max(0, Math.floor(Number(hideTokens) || 0))
  if (!hide) return usage
  const out = { ...usage }
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    out.cache_creation = { ...usage.cache_creation }
  }
  const cacheRead = num(out.cache_read_input_tokens ?? out.cache_read_tokens)
  const cacheCreate = num(out.cache_creation_input_tokens ?? out.cache_creation_tokens)
  const alreadyCached = cacheRead + cacheCreate
  const stillInInput = Math.max(0, hide - alreadyCached)
  const inputKey = out.input_tokens != null ? 'input_tokens' : (out.prompt_tokens != null ? 'prompt_tokens' : 'input_tokens')
  const inputNow = num(out[inputKey])
  const moved = Math.min(inputNow, stillInInput)
  if (moved > 0) {
    out[inputKey] = inputNow - moved
    if (inputKey === 'input_tokens' && out.prompt_tokens != null) {
      out.prompt_tokens = Math.max(0, num(out.prompt_tokens) - moved)
    }
    if (cacheRead > 0 || cacheCreate === 0) {
      addTokens(out, 'cache_read_input_tokens', moved)
      if (usage.cache_read_tokens != null) addTokens(out, 'cache_read_tokens', moved)
    } else {
      addTokens(out, 'cache_creation_input_tokens', moved)
      if (out.cache_creation_tokens != null) addTokens(out, 'cache_creation_tokens', moved)
      if (!out.cache_creation) out.cache_creation = {}
      const createBucket = String(cacheTtl || '').toLowerCase() === '1h'
        ? 'ephemeral_1h_input_tokens'
        : 'ephemeral_5m_input_tokens'
      addTokens(out.cache_creation, createBucket, moved)
    }
  }
  const input = out.input_tokens != null ? num(out.input_tokens) : null
  const prompt = out.prompt_tokens != null ? num(out.prompt_tokens) : null
  const output = out.output_tokens != null ? num(out.output_tokens) : (out.completion_tokens != null ? num(out.completion_tokens) : null)
  if (out.total_tokens != null && (input != null || prompt != null) && output != null) {
    out.total_tokens = (input ?? prompt) + output
  }
  return out
}

export function hidePersonaUsageInEvent(event, hideTokens = 0, cacheTtl = '5m') {
  if (!event || typeof event !== 'object' || !hideTokens) return event
  const out = { ...event }
  if (out.usage) out.usage = hidePersonaUsage(out.usage, hideTokens, cacheTtl)
  if (out.message && typeof out.message === 'object' && out.message.usage) {
    out.message = { ...out.message, usage: hidePersonaUsage(out.message.usage, hideTokens, cacheTtl) }
  }
  return out
}

export function hidePersonaUsageInSseLine(line, hideTokens = 0, cacheTtl = '5m') {
  if (!hideTokens || line == null) return line
  const raw = String(line)
  const m = raw.match(/^(data:\s*)(.*)$/)
  if (!m || !m[2] || m[2] === '[DONE]') return raw
  try {
    const evt = JSON.parse(m[2])
    return m[1] + JSON.stringify(hidePersonaUsageInEvent(evt, hideTokens, cacheTtl))
  } catch {
    return raw
  }
}

export function hidePersonaUsageOnMessage(body, hideTokens = 0, cacheTtl = '5m') {
  if (!body || typeof body !== 'object' || !hideTokens || !body.usage) return body
  return { ...body, usage: hidePersonaUsage(body.usage, hideTokens, cacheTtl) }
}
