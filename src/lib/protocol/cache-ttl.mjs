/**
 * Anthropic cache_control ttl for unofficial OAuth.
 * Default 5m (1.25× input). Customers may request 1h (2× input);
 * billing must use the 1h bucket so the difference is charged.
 */
import fs from 'node:fs'

export const DEFAULT_CACHE_TTL = '5m'
export const CACHE_TTL_HEADER = 'x-kin-cache-ttl'

export function normalizeCacheTtl(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_CACHE_TTL
  if (raw === '1h' || raw === '1hr' || raw === '60m' || raw === '3600' || raw === 'hour' || raw === '1hour') return '1h'
  if (raw === '5m' || raw === '5min' || raw === '300' || raw === 'default') return '5m'
  return DEFAULT_CACHE_TTL
}

export function cacheTtlFromRouting(routing = {}) {
  return normalizeCacheTtl(routing?.compatibility?.cache_ttl)
}

export function cacheTtlFromRoutingFile(filePath) {
  if (!filePath) return DEFAULT_CACHE_TTL
  try {
    return cacheTtlFromRouting(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return DEFAULT_CACHE_TTL
  }
}

/** Header wins, then routing.json (hot-read), then 5m. Official traffic should pass null and skip. */
export function resolveCacheTtl({ headers = {}, routing, routingFile } = {}) {
  const hdr = headers[CACHE_TTL_HEADER] || headers['X-Kin-Cache-Ttl']
  if (hdr != null && String(hdr).trim()) return normalizeCacheTtl(hdr)
  if (routing) return cacheTtlFromRouting(routing)
  return cacheTtlFromRoutingFile(routingFile)
}

function setEphemeralTtl(control, ttl) {
  if (!control || typeof control !== 'object') return { type: 'ephemeral', ttl }
  if (control.type && control.type !== 'ephemeral') return control
  return { ...control, type: 'ephemeral', ttl }
}

/** Force every ephemeral cache_control.ttl on the outbound body. */
export function applyCacheTtlToBody(body, ttl = DEFAULT_CACHE_TTL) {
  const target = normalizeCacheTtl(ttl)
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  if (out.cache_control) out.cache_control = setEphemeralTtl(out.cache_control, target)
  if (Array.isArray(out.system)) {
    out.system = out.system.map((block) => (
      block?.cache_control ? { ...block, cache_control: setEphemeralTtl(block.cache_control, target) } : block
    ))
  }
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.map((tool) => (
      tool?.cache_control ? { ...tool, cache_control: setEphemeralTtl(tool.cache_control, target) } : tool
    ))
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => (
          block?.cache_control ? { ...block, cache_control: setEphemeralTtl(block.cache_control, target) } : block
        )),
      }
    })
  }
  return out
}

function n(v) {
  return Number(v) || 0
}

/**
 * Put cache-creation tokens into the TTL we actually sent.
 * If Anthropic omitted the 5m/1h split, or reported 5m after we sent 1h,
 * reclassify so pricing charges the 1h difference.
 */
export function applyCacheTtlToUsage(usage, ttl = DEFAULT_CACHE_TTL) {
  if (!usage || typeof usage !== 'object') return usage
  const target = normalizeCacheTtl(ttl)
  const out = { ...usage, cache_ttl: target }
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    out.cache_creation = { ...usage.cache_creation }
  }
  const five = n(out.cache_creation_5m_tokens ?? out.cache_creation?.ephemeral_5m_input_tokens)
  const hour = n(out.cache_creation_1h_tokens ?? out.cache_creation?.ephemeral_1h_input_tokens)
  const create = n(out.cache_creation_input_tokens ?? out.cache_creation_tokens)
  let total = five + hour
  if (!total && create) total = create
  if (!total) return out
  if (target === '1h') {
    out.cache_creation_1h_tokens = total
    out.cache_creation_5m_tokens = 0
    if (!out.cache_creation) out.cache_creation = {}
    out.cache_creation.ephemeral_1h_input_tokens = total
    out.cache_creation.ephemeral_5m_input_tokens = 0
  } else {
    out.cache_creation_5m_tokens = total
    out.cache_creation_1h_tokens = 0
    if (!out.cache_creation) out.cache_creation = {}
    out.cache_creation.ephemeral_5m_input_tokens = total
    out.cache_creation.ephemeral_1h_input_tokens = 0
  }
  return out
}
