const ENTITLEMENT_PATTERNS = [
  /extra usage required/i,
  /usage credits? (?:are )?required/i,
  /fast (?:mode|request).*(?:credit|entitlement)/i,
]

const SIGNATURE_PATTERNS = [
  /thinking\.signature/i,
  /invalid.*signature/i,
  /function_response.*signature/i,
  /tool_(?:use|result).*signature/i,
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

export function classifyUpstreamResult(result = {}, {
  model = null,
  now = Date.now(),
  repaired = false,
} = {}) {
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
    if (!repaired && SIGNATURE_PATTERNS.some((pattern) => pattern.test(`${code} ${message}`))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'signature_repairable',
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

export function repairAnthropicRequest(body = {}, policy = {}) {
  if (policy.action !== 'repair-and-retry') return body
  const out = structuredClone(body)
  if (out.thinking) delete out.thinking
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      const content = message.content
        .filter((block) => !(block?.type === 'thinking' && !block?.signature))
        .map((block) => {
          if (block?.type === 'redacted_thinking') return { type: 'text', text: '[redacted thinking]' }
          return block
        })
      return { ...message, content }
    })
  }
  return out
}
