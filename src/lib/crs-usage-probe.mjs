/**
 * CRS-aligned account status probe.
 * All Anthropic I/O runs as the VM UID (SOCKS egress). Host never calls Anthropic.
 */
import { isCrsMock } from './crs-mock.mjs'
import { callGoWorker, callWorkerGet } from './go-worker-client.mjs'

export const FABLE_PROBE_MODEL = 'claude-fable-5'
export const OAUTH_USAGE_PATH = '/api/oauth/usage'

export function normUtilization(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n > 1.5 ? n / 100 : n
}

export function statusFromUtilization(u) {
  if (u == null) return null
  if (u >= 1) return 'rejected'
  if (u >= 0.85) return 'allowed_warning'
  return 'allowed'
}

export function parseOAuthUsage(data = {}) {
  const windowOf = (w) => {
    if (!w || typeof w !== 'object') return null
    const utilization = normUtilization(w.utilization)
    return {
      utilization,
      utilization_pct: utilization == null ? null : Math.round(utilization * 1000) / 10,
      resets_at: w.resets_at || w.resetsAt || null,
      status: w.status || statusFromUtilization(utilization),
    }
  }
  const extra = data.extra_usage || data.extraUsage || null
  return {
    five_hour: windowOf(data.five_hour),
    seven_day: windowOf(data.seven_day),
    seven_day_sonnet: windowOf(data.seven_day_sonnet),
    seven_day_opus: windowOf(data.seven_day_opus || data.seven_day_sonnet),
    extra_usage: extra && typeof extra === 'object'
      ? {
        is_enabled: !!(extra.is_enabled ?? extra.enabled),
        utilization: normUtilization(extra.utilization),
        resets_at: extra.resets_at || extra.resetsAt || null,
        status: extra.status || extra.overage_status || extra.overageStatus || null,
      }
      : null,
  }
}

export function parseFableProbe({ status, body } = {}) {
  const err = body?.error || {}
  const msg = String(err.message || body?.message || '')
  const typ = String(err.type || '')
  const limited = status === 429 || /rate.?limit/i.test(typ) || /rate.?limit/i.test(msg)
  const banned = status === 401 || status === 403 || /oauth|authentication|permission/i.test(typ)
  return {
    model: FABLE_PROBE_MODEL,
    status: status || 0,
    ok: status === 200 && !limited && !banned,
    limited,
    banned,
    reset_at: body?.error?.resets_at || body?.resets_at || null,
    error: limited || banned || status >= 400 ? (msg || typ || `http_${status}`) : null,
  }
}

function mockUsage() {
  return {
    five_hour: { utilization: 0.12, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 0.34, resets_at: '2026-08-24T00:00:00Z' },
    seven_day_sonnet: { utilization: 0.08, resets_at: '2026-08-24T00:00:00Z' },
    extra_usage: { is_enabled: false, utilization: 0 },
  }
}

export async function probeVmUsage({
  exec,
  includeFable = true,
  timeoutMs = 20000,
  identity = null,
} = {}) {
  if (!exec) {
    return { ok: false, source: 'vm-oauth-usage', error: 'no_exec', probed_at: new Date().toISOString() }
  }
  if (isCrsMock()) {
    const parsed = parseOAuthUsage(mockUsage())
    return {
      ok: true,
      source: 'vm-oauth-usage',
      via: 'crs-mock',
      ...parsed,
      fable: includeFable
        ? { model: FABLE_PROBE_MODEL, status: 200, ok: true, limited: false, banned: false, reset_at: null, error: null }
        : null,
      probed_at: new Date().toISOString(),
    }
  }
  const usageRes = await callWorkerGet(exec, '/internal/oauth/usage', { timeoutMs })
  const parsed = usageRes.ok ? parseOAuthUsage(usageRes.body) : {
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    extra_usage: null,
  }

  let fable = null
  if (includeFable) {
    const fableRes = await callGoWorker({
      exec,
      timeoutMs,
      identity,
      body: {
        model: FABLE_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      reqHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    fable = parseFableProbe(fableRes)
  }

  const usageDenied = usageRes.status === 401 || usageRes.status === 403
  return {
    ok: !!(usageRes.ok || (includeFable && fable?.ok)) && !usageDenied,
    source: 'vm-oauth-usage',
    via: usageRes.via || 'go-worker',
    usage_status: usageRes.status,
    usage_error: usageRes.ok ? null : (usageRes.body?.error?.message || usageRes.body?.error || `http_${usageRes.status}`),
    ...parsed,
    fable,
    probed_at: new Date().toISOString(),
  }
}
