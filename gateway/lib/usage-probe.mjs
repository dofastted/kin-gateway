/**
 * Official Claude usage probing
 * 1) GET https://api.anthropic.com/api/oauth/usage  (Claude Code /usage)
 * 2) Fallback: lightweight messages call → unified rate-limit headers
 */

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

export async function probeOauthUsage(accessToken, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
        'user-agent': 'claude-cli/2.1.233 (external, sdk-cli)',
        'x-app': 'cli',
      },
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      source: 'oauth_usage',
      data: normalizeOauthUsage(body),
      raw: body,
    }
  } catch (e) {
    return { ok: false, status: 0, source: 'oauth_usage', error: String(e.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fallback probe: 1-token messages request to read unified headers (same as Claude Code runtime)
 */
export async function probeViaMessagesHeaders(accessToken, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
        'user-agent': 'claude-cli/2.1.233 (external, sdk-cli)',
        'x-app': 'cli',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    })
    const headers = {}
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
    return {
      ok: res.status >= 200 && res.status < 300 || res.status === 429,
      status: res.status,
      source: 'messages_headers',
      data: normalizeFromHeaders(headers),
      headers,
      body,
    }
  } catch (e) {
    return { ok: false, status: 0, source: 'messages_headers', error: String(e.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeAccount(accessToken, opts = {}) {
  // Prefer official oauth/usage; fall back to headers on failure/429
  const primary = await probeOauthUsage(accessToken, opts)
  if (primary.ok && primary.data) {
    return { ...primary, probed_at: new Date().toISOString() }
  }
  const fallback = await probeViaMessagesHeaders(accessToken, opts)
  return {
    ...fallback,
    primary_error: primary.error || primary.raw || { status: primary.status },
    probed_at: new Date().toISOString(),
  }
}

function normalizeOauthUsage(body) {
  if (!body || typeof body !== 'object') return null
  // utilization in oauth/usage is often 0-100 scale
  const toRatio = (u) => {
    if (u == null) return null
    const n = Number(u)
    if (!Number.isFinite(n)) return null
    return n > 1 ? n / 100 : n
  }
  return {
    five_hour: body.five_hour
      ? {
          utilization: toRatio(body.five_hour.utilization),
          utilization_pct: scalePct(body.five_hour.utilization),
          resets_at: body.five_hour.resets_at || null,
        }
      : null,
    seven_day: body.seven_day
      ? {
          utilization: toRatio(body.seven_day.utilization),
          utilization_pct: scalePct(body.seven_day.utilization),
          resets_at: body.seven_day.resets_at || null,
        }
      : null,
    seven_day_sonnet: body.seven_day_sonnet
      ? {
          utilization: toRatio(body.seven_day_sonnet.utilization),
          utilization_pct: scalePct(body.seven_day_sonnet.utilization),
          resets_at: body.seven_day_sonnet.resets_at || null,
        }
      : null,
    seven_day_opus: body.seven_day_opus
      ? {
          utilization: toRatio(body.seven_day_opus.utilization),
          utilization_pct: scalePct(body.seven_day_opus.utilization),
          resets_at: body.seven_day_opus.resets_at || null,
        }
      : null,
    extra_usage: body.extra_usage || null,
  }
}

function normalizeFromHeaders(h) {
  const u5 = num(h['anthropic-ratelimit-unified-5h-utilization'])
  const u7 = num(h['anthropic-ratelimit-unified-7d-utilization'])
  return {
    five_hour: {
      utilization: u5,
      utilization_pct: u5 != null ? +(u5 * 100).toFixed(2) : null,
      resets_at: epochToIso(h['anthropic-ratelimit-unified-5h-reset']),
      status: h['anthropic-ratelimit-unified-5h-status'] || null,
    },
    seven_day: {
      utilization: u7,
      utilization_pct: u7 != null ? +(u7 * 100).toFixed(2) : null,
      resets_at: epochToIso(h['anthropic-ratelimit-unified-7d-reset']),
      status: h['anthropic-ratelimit-unified-7d-status'] || null,
    },
    representative_claim: h['anthropic-ratelimit-unified-representative-claim'] || null,
    overage_status: h['anthropic-ratelimit-unified-overage-status'] || null,
    unified_status: h['anthropic-ratelimit-unified-status'] || null,
  }
}

function scalePct(u) {
  if (u == null) return null
  const n = Number(u)
  if (!Number.isFinite(n)) return null
  return n > 1 ? +n.toFixed(2) : +(n * 100).toFixed(2)
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function epochToIso(v) {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  // seconds vs ms
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toISOString()
}
