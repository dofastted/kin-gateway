/**
 * CRS-aligned account status probe.
 * All Anthropic I/O runs as the VM UID (SOCKS egress). Host never calls Anthropic.
 */
import { isCrsMock } from '../transport/crs-mock.mjs'
import { callGoWorker, callWorkerGet } from '../transport/go-worker-client.mjs'

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

function windowOf(w) {
  if (!w || typeof w !== 'object') return null
  const utilization = normUtilization(w.utilization ?? w.percent)
  if (utilization == null && !w.resets_at && !w.resetsAt && !w.status) return null
  return {
    utilization,
    utilization_pct: utilization == null ? null : Math.round(utilization * 1000) / 10,
    resets_at: w.resets_at || w.resetsAt || null,
    status: w.status || statusFromUtilization(utilization),
  }
}

function fableScopeName(value) {
  return /fable/i.test(String(value || ''))
}

/** Fable weekly window (7d_oi) from /api/oauth/usage — limits[] weekly_scoped, not a boolean. */
export function parseFableScopedWindow(data = {}) {
  const direct = windowOf(data.seven_day_overage_included || data.seven_day_oi || data.seven_day_fable)
  if (direct) return direct
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    if (!item || typeof item !== 'object') continue
    const kind = String(item.kind || '').toLowerCase()
    const name = item.scope?.model?.display_name || item.scope?.display_name || item.display_name || item.model || ''
    const scoped = kind === 'weekly_scoped' || kind === 'seven_day_overage_included' || kind === '7d_oi'
    if (!scoped || !fableScopeName(name)) continue
    return windowOf(item)
  }
  for (const item of Array.isArray(data.model_scoped) ? data.model_scoped : []) {
    if (!item || typeof item !== 'object') continue
    if (!fableScopeName(item.display_name || item.name)) continue
    return windowOf(item)
  }
  return null
}

export function windowFromRateLimitHeaders(headers = {}, prefix = '7d_oi') {
  const h = {}
  for (const [key, value] of Object.entries(headers || {})) h[String(key).toLowerCase()] = value
  return windowOf({
    utilization: h[`anthropic-ratelimit-unified-${prefix}-utilization`],
    resets_at: h[`anthropic-ratelimit-unified-${prefix}-reset`] || null,
    status: h[`anthropic-ratelimit-unified-${prefix}-status`] || null,
  })
}

export function parseOAuthUsage(data = {}) {
  const extra = data.extra_usage || data.extraUsage || null
  return {
    five_hour: windowOf(data.five_hour),
    seven_day: windowOf(data.seven_day),
    seven_day_sonnet: windowOf(data.seven_day_sonnet),
    seven_day_opus: windowOf(data.seven_day_opus || data.seven_day_sonnet),
    seven_day_oi: parseFableScopedWindow(data),
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

export function parseFableProbe({ status, body, transportError, headers } = {}) {
  const err = body?.error || {}
  const msg = String(err.message || body?.message || err.code || '')
  const typ = String(err.type || err.code || '')
  const transport = !!transportError
    || status === 0
    || /SOCKS|transport|connection reset|worker_error|upstream_transport|refusing SOCKS/i.test(msg)
    || /SOCKS|transport/i.test(typ)
    || (status === 502 && /SOCKS|greeting|reset by peer/i.test(msg))
  const planDenied = !transport && (status === 403 || (/permission/i.test(typ) && status !== 401))
  const limited = !transport && !planDenied && (status === 429 || /rate.?limit/i.test(typ) || /rate.?limit/i.test(msg))
  // 401 / oauth 才是整号吊销。403 permission 是 Pro 无 Fable，不是封号。
  const banned = !transport && !planDenied && (status === 401 || /oauth|authentication/i.test(typ))
  const oi = windowFromRateLimitHeaders(headers)
  // 不要把无 7d_oi 窗的 429 写成 100%——Pro 探测 Fable 也会 429。
  const utilization = oi?.utilization ?? null
  return {
    model: FABLE_PROBE_MODEL,
    status: status || 0,
    ok: status === 200 && !limited && !banned && !transport && !planDenied,
    limited,
    banned,
    plan_denied: planDenied,
    transport,
    utilization,
    reset_at: body?.error?.resets_at || body?.resets_at || oi?.resets_at || null,
    seven_day_oi: oi || (utilization != null ? {
      utilization,
      utilization_pct: Math.round(utilization * 1000) / 10,
      resets_at: body?.error?.resets_at || body?.resets_at || null,
      status: limited ? 'rejected' : statusFromUtilization(utilization),
    } : null),
    error: limited || banned || planDenied || transport || status >= 400 ? (msg || typ || `http_${status}`) : null,
  }
}

/** Fable 403/permission = 套餐没有 Fable（Pro），不是账号吊销。 */
export function isFablePlanDenied(fb = {}) {
  if (!fb || typeof fb !== 'object') return false
  if (fb.plan_denied) return true
  const st = Number(fb.status || 0)
  const err = String(fb.error || fb.type || '')
  if (st === 401 || /oauth|authentication/i.test(err)) return false
  return st === 403 || /permission/i.test(err)
}

function mockUsage() {
  return {
    five_hour: { utilization: 0.12, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 0.34, resets_at: '2026-08-24T00:00:00Z' },
    seven_day_sonnet: { utilization: 0.08, resets_at: '2026-08-24T00:00:00Z' },
    extra_usage: { is_enabled: false, utilization: 0 },
    limits: [{
      kind: 'weekly_scoped',
      percent: 21,
      resets_at: '2026-08-24T00:00:00Z',
      scope: { model: { display_name: 'Fable' } },
    }],
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
        ? {
          model: FABLE_PROBE_MODEL,
          status: 200,
          ok: true,
          limited: false,
          banned: false,
          utilization: parsed.seven_day_oi?.utilization ?? 0.21,
          reset_at: parsed.seven_day_oi?.resets_at || null,
          error: null,
        }
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
    seven_day_oi: null,
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
      // Do not send inbound anthropic-beta — unofficial probes must replay
      // the slot's stored Claude Code betas, not overwrite them.
    })
    fable = parseFableProbe(fableRes)
    // Usage API succeeding means the slot grant is not revoked.
    // A Fable-only 401 is Pro / format noise, not 整号吊销.
    if (usageRes.ok && fable && (fable.banned || fable.status === 401 || /revoked|oauth|authentication/i.test(String(fable.error || '')))) {
      fable = {
        ...fable,
        banned: false,
        plan_denied: true,
        error: fable.plan_denied || fable.status === 403 ? fable.error : 'plan_denied',
      }
    }
  }

  const sevenDayOi = parsed.seven_day_oi || fable?.seven_day_oi || null
  if (fable && sevenDayOi) {
    const oiFull = ['rejected', 'rate_limited'].includes(String(sevenDayOi.status || '').toLowerCase())
      || (sevenDayOi.utilization != null && Number(sevenDayOi.utilization) >= 1)
    fable = {
      ...fable,
      utilization: sevenDayOi.utilization ?? fable.utilization ?? null,
      reset_at: sevenDayOi.resets_at || fable.reset_at || null,
      limited: oiFull || (fable.limited && sevenDayOi.utilization == null),
    }
  }

  const usageDenied = usageRes.status === 401 || usageRes.status === 403
  return {
    ok: !!(usageRes.ok || (includeFable && fable?.ok)) && !usageDenied,
    source: 'vm-oauth-usage',
    via: usageRes.via || 'go-worker',
    usage_status: usageRes.status,
    usage_error: usageRes.ok ? null : (usageRes.body?.error?.message || usageRes.body?.error || `http_${usageRes.status}`),
    ...parsed,
    seven_day_oi: sevenDayOi,
    fable,
    probed_at: new Date().toISOString(),
  }
}
