import { normalizeThinkingForModel } from '../protocol/thinking.mjs'
import { rectifyUnofficialRequestForRetry } from '../protocol/request-rectifier.mjs'

const ENTITLEMENT_PATTERNS = [
  /extra usage required/i,
  /usage credits? (?:are )?required/i,
  /fast (?:mode|request).*(?:credit|entitlement)/i,
]

const SIGNATURE_PATTERNS = [
  /signature/i,
  /expected[`\s].*thinking/i,
  /cannot be modified/i,
  /must contain thinking/i,
  /each thinking block/i,
]

const PREFILL_PATTERNS = [
  /conversation must (?:end|start)/i,
  /final (?:assistant )?message/i,
  /messages?:.*(?:end|start).*(?:user|assistant)/i,
  /must (?:end|start) with a user/i,
]

const TOOL_PAIR_PATTERNS = [
  /tool_use.*tool_result/i,
  /tool_result.*(?:required|missing|expected)/i,
  /tool_use_id/i,
]

const SCHEMA_PATTERNS = [
  /additionalProperties/i,
  /output_config/i,
]

const ADAPTIVE_PATTERNS = [
  /adaptive thinking/i,
  /thinking\.type.*adaptive/i,
  /does not support adaptive/i,
]

const ORGANIZATION_DISABLED_PATTERNS = [
  /organization has been disabled/i,
  /oauth authentication is currently not allowed/i,
  /organization.*(?:blocked|banned|disabled)/i,
]

function bodyMessage(body) {
  if (typeof body === 'string') return body
  return String(
    body?.error?.message ||
    body?.error?.error ||
    body?.message ||
    body?.error ||
    '',
  )
}

function bodyCode(body) {
  return String(body?.error?.code || body?.error?.type || body?.type || '')
}

function header(headers, name) {
  const target = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value
  }
  return null
}

function resetFromHeaders(headers, now = Date.now()) {
  const retryAfter = header(headers, 'retry-after')
  if (retryAfter != null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
    const parsed = Date.parse(String(retryAfter))
    if (Number.isFinite(parsed)) return parsed
  }
  const resetNames = [
    'anthropic-ratelimit-unified-5h-reset',
    'anthropic-ratelimit-unified-7d-reset',
    'anthropic-ratelimit-requests-reset',
  ]
  const resets = resetNames
    .map((name) => header(headers, name))
    .map((value) => {
      if (value == null) return null
      const number = Number(value)
      if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number
      const parsed = Date.parse(String(value))
      return Number.isFinite(parsed) ? parsed : null
    })
    .filter((value) => value && value > now)
  return resets.length ? Math.min(...resets) : null
}

export const FABLE_FAMILY_KEY = 'fable'

function modelFamily(model) {
  const value = String(model || '').toLowerCase()
  for (const family of ['opus', 'sonnet', 'haiku', 'fable']) {
    if (value.includes(family)) return family
  }
  return null
}

export function isFableModel(model) {
  return String(model || '').toLowerCase().includes('fable')
}

export function modelCooldownKeys(model) {
  const key = normalizeModelKey(model)
  if (!key) return []
  const keys = [key]
  if (isFableModel(key) && key !== FABLE_FAMILY_KEY) keys.push(FABLE_FAMILY_KEY)
  return keys
}

function isFableWindowLimit(headers) {
  const claim = String(header(headers, 'anthropic-ratelimit-unified-representative-claim') || '')
  const statusOi = String(header(headers, 'anthropic-ratelimit-unified-7d_oi-status') || '').toLowerCase()
  return /seven_day_overage_included|7d_oi/i.test(claim)
    || statusOi === 'rejected'
    || statusOi === 'rate_limited'
}

function fableResetFromHeaders(headers, now = Date.now()) {
  const raw = header(headers, 'anthropic-ratelimit-unified-7d_oi-reset')
  if (raw == null) return null
  const number = Number(raw)
  if (Number.isFinite(number)) {
    const ms = number < 1e12 ? number * 1000 : number
    return ms > now ? ms : null
  }
  const parsed = Date.parse(String(raw))
  return Number.isFinite(parsed) && parsed > now ? parsed : null
}

function isUnifiedAccountLimit(headers) {
  const status5h = String(header(headers, 'anthropic-ratelimit-unified-5h-status') || '').toLowerCase()
  const status7d = String(header(headers, 'anthropic-ratelimit-unified-7d-status') || '').toLowerCase()
  return [status5h, status7d].some((status) => (
    status === 'rejected' || status === 'rate_limited'
  ))
}

function resultErrorCode(result) {
  return String(result?.body?.error?.code || result?.body?.error?.type || '')
}

const TIMEOUT_PATTERNS = /timeout|deadline|response header|timed out/i

function isTimeoutFailure(workerCode, message) {
  return TIMEOUT_PATTERNS.test(`${workerCode} ${message}`)
}

function isProxyFailure(workerCode, message) {
  const hay = `${workerCode} ${message}`
  if (isTimeoutFailure(workerCode, message)) return false
  return /proxy|socks|dial|dns|tls|connect/i.test(hay)
}

function continueWithoutCooldown({
  scope,
  reason,
  retrySameAccount = true,
} = {}) {
  return {
    scope,
    action: 'continue',
    reason,
    cooldownUntil: null,
    retrySameAccount,
  }
}

function claudeStopReasonOf(result) {
  return String(result?.stopReason || result?.body?.stop_reason || '')
}

function claudeHasVisibleOutput(body) {
  const content = body?.content || body?.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block?.type === 'text' && String(block.text || '').trim()) return true
    if (block?.type === 'tool_use') return true
    if (block?.type === 'refusal' && String(block.refusal || block.text || '').trim()) return true
  }
  return false
}

/** 200 + stop_reason=refusal with no visible text — not a successful empty reply. */
export function isSilentClaudeRefusal(result = {}) {
  if (claudeStopReasonOf(result) !== 'refusal') return false
  return !claudeHasVisibleOutput(result.body)
}

export function classifyUpstreamResult(result = {}, {
  model = null,
  now = Date.now(),
  repaired = false,
} = {}) {
  if (isSilentClaudeRefusal(result) && !result.committed) {
    return { scope: 'request', action: 'stop', reason: 'content_filter_refusal', cooldownUntil: null }
  }
  if (result.ok && result.terminalState !== 'incomplete') {
    return { scope: 'success', action: 'complete', cooldownUntil: null }
  }
  const status = Number(result.status) || 0
  const message = bodyMessage(result.body)
  const code = bodyCode(result.body)
  const workerCode = resultErrorCode(result)
  const reset = resetFromHeaders(result.headers, now)

  if (workerCode === 'selection_cancelled' || /aborted|cancelled|canceled/i.test(workerCode)) {
    return { scope: 'client_lifecycle', action: 'stop', reason: 'client_cancelled', cooldownUntil: null }
  }
  if (result.committed) {
    return {
      scope: 'stream',
      action: 'stop',
      reason: 'downstream_committed_or_incomplete',
      cooldownUntil: null,
    }
  }
  if (result.transportError || status === 0) {
    if (isProxyFailure(workerCode, message)) {
      return {
        scope: 'proxy',
        action: 'continue-and-cooldown',
        reason: 'proxy_transport_failure',
        cooldownUntil: now + 60_000,
      }
    }
    return continueWithoutCooldown({
      scope: 'worker',
      reason: isTimeoutFailure(workerCode, message)
        ? 'worker_timeout'
        : 'worker_transport_failure',
    })
  }
  if (status === 400) {
    const hay = `${code} ${message}`
    if (!repaired && SIGNATURE_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'signature_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && PREFILL_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'prefill_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && TOOL_PAIR_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'tool_pair_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && SCHEMA_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'schema_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && ADAPTIVE_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'thinking_repairable',
        cooldownUntil: null,
      }
    }
    return { scope: 'request', action: 'stop', reason: 'invalid_request', cooldownUntil: null }
  }
  if (status === 401) {
    return {
      scope: 'credential',
      action: 'continue-and-cooldown',
      reason: 'authentication_failed_after_refresh',
      cooldownUntil: now + 10 * 60_000,
    }
  }
  if (status === 403) {
    if (ORGANIZATION_DISABLED_PATTERNS.some((pattern) => pattern.test(message))) {
      return {
        scope: 'account',
        action: 'disable',
        reason: 'organization_disabled',
        cooldownUntil: null,
      }
    }
    if (/<html|cloudflare|proxy/i.test(message)) {
      return {
        scope: 'proxy',
        action: 'continue-and-cooldown',
        reason: 'proxy_or_edge_forbidden',
        cooldownUntil: now + 60_000,
      }
    }
    return {
      scope: 'credential',
      action: 'continue-and-cooldown',
      reason: 'permission_denied',
      cooldownUntil: now + 10 * 60_000,
    }
  }
  if (status === 429) {
    if (ENTITLEMENT_PATTERNS.some((pattern) => pattern.test(message))) {
      return { scope: 'request', action: 'stop', reason: 'entitlement_required', cooldownUntil: null }
    }
    if (isUnifiedAccountLimit(result.headers)) {
      return {
        scope: 'account',
        action: 'continue-and-cooldown',
        reason: 'account_quota_exhausted',
        cooldownUntil: reset || now + 5 * 60_000,
      }
    }
    if (isFableWindowLimit(result.headers) || isFableModel(model)) {
      const fableReset = fableResetFromHeaders(result.headers, now) || reset
      return {
        scope: 'model',
        action: 'continue-and-cooldown',
        reason: 'fable_rate_limited',
        model: FABLE_FAMILY_KEY,
        cooldownUntil: fableReset || now + 60_000,
      }
    }
    const family = modelFamily(model)
    if (family) {
      return {
        scope: 'model',
        action: 'continue-and-cooldown',
        reason: `${family}_rate_limited`,
        model: family === 'fable' ? FABLE_FAMILY_KEY : normalizeModelKey(model),
        cooldownUntil: reset || now + 60_000,
      }
    }
    return {
      scope: 'account',
      action: 'continue-and-cooldown',
      reason: 'rate_limited',
      cooldownUntil: reset || now + 60_000,
    }
  }
  if (status === 529) {
    return {
      scope: 'provider',
      action: 'continue-and-cooldown',
      reason: 'provider_overloaded',
      cooldownUntil: now + 15_000,
    }
  }
  if (status === 408 || status === 502 || status === 503 || status === 504 || status >= 500) {
    if (isFableModel(model) && (status === 408 || status === 504 || /timeout/i.test(message))) {
      return {
        scope: 'model',
        action: 'continue-and-cooldown',
        reason: 'fable_timeout',
        model: FABLE_FAMILY_KEY,
        cooldownUntil: now + 30_000,
      }
    }
    return continueWithoutCooldown({
      scope: 'provider',
      reason: isTimeoutFailure(workerCode, message)
        ? 'provider_timeout'
        : 'provider_transient_error',
    })
  }
  return { scope: 'request', action: 'stop', reason: `http_${status}`, cooldownUntil: null }
}

export function shouldContinue(policy) {
  return policy?.action === 'continue' || policy?.action === 'continue-and-cooldown'
}

export function normalizeModelKey(model) {
  return String(model || '').trim().toLowerCase()
}

function placeholderContent(role) {
  return [{
    type: 'text',
    text: role === 'assistant' ? '(assistant content removed)' : '(content removed)',
  }]
}

function rectifyMessageContent(content, role) {
  if (!Array.isArray(content)) return content
  const next = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      next.push(block)
      continue
    }
    if (block.type === 'text' && !String(block.text || '').trim()) continue
    if (block.type === 'thinking') {
      const text = String(block.thinking || '').trim()
      if (text) next.push({ type: 'text', text })
      continue
    }
    if (block.type === 'redacted_thinking') continue
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      next.push({ ...block, content: rectifyMessageContent(block.content, role) })
      continue
    }
    next.push(block)
  }
  return next.length ? next : placeholderContent(role)
}

/** Convert every thinking block to text and disable top-level thinking (sub2api retry). */
export function repairAnthropicRequest(body = {}, policy = {}) {
  if (policy.action !== 'repair-and-retry') return body
  const reason = String(policy.reason || '')
  if (reason === 'prefill_repairable' || reason === 'tool_pair_repairable' || reason === 'schema_repairable') {
    return rectifyUnofficialRequestForRetry(body)
  }
  if (reason === 'thinking_repairable') {
    const next = structuredClone(body)
    normalizeThinkingForModel(next)
    return next
  }
  const out = structuredClone(body)
  if (out.thinking) delete out.thinking
  if (Array.isArray(out.context_management?.edits)) {
    const edits = out.context_management.edits.filter((edit) => edit?.type !== 'clear_thinking_20251015')
    if (edits.length) out.context_management.edits = edits
    else delete out.context_management.edits
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return { ...message, content: rectifyMessageContent(message.content, message.role) }
    })
  }
  return out
}
