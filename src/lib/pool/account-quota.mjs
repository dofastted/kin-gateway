/**
 * Per-account Claude usage quota tracker (SQLite-backed).
 * Uses anthropic-ratelimit-unified-* headers (OAuth beta) for 5h / 7d utilization.
 * Soft-blocks at safety_ratio (default 0.95) before hard rate limit.
 *
 * Persistent state → `accounts` + `account_allocations` tables.
 * Transient state (inflight counters) stays in memory.
 */

import { resolveStoreDb } from '../db/database.mjs'
import { AccountsRepo } from '../db/repos/accounts-repo.mjs'
import { computeWeeklySplit, weeklySplitConfig } from './weekly-split.mjs'
import { applyEffectiveWindows, effectiveRateWindow, WINDOW_5H_MS, WINDOW_7D_MS } from './quota-window.mjs'

export class AccountQuota {
  constructor({ dataDir, db, config, accounts }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new AccountsRepo(this.db)
    this.config = config?.quota || { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true }
    this.concurrency = config?.concurrency || { default_max_per_account: 20 }
    this.inflight = new Map() // accountId → count
    // seed accounts
    for (const a of accounts || []) this.ensure(a)
  }

  /** Kept for API compat + post-restore hook (no in-memory cache to refresh). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new AccountsRepo(db)
  }

  /**
   * Optional structured window write-through target (AccountRuntimeRepo).
   * Mirrors the 5h session window + rate-limit resets into queryable columns.
   */
  attachRuntimeRepo(runtimeRepo) {
    this.runtimeRepo = runtimeRepo || null
  }

  _writeSessionWindow(acc) {
    if (!this.runtimeRepo?.updateWindow || !acc) return
    const endIso = acc.unified?.['5h']?.reset || null
    const endMs = endIso ? Date.parse(endIso) : NaN
    try {
      this.runtimeRepo.updateWindow(acc.account_id, {
        vmId: acc.vm_id || null,
        sessionWindowEnd: Number.isFinite(endMs) ? endMs : null,
        sessionWindowStart: Number.isFinite(endMs) ? endMs - 5 * 3600_000 : null,
        sessionWindowStatus: acc.unified?.['5h']?.status || null,
      })
    } catch {}
  }

  ensure(account) {
    const id = account.account_id || account.account_uuid || account.id
    if (!id) return
    let acc = this.repo.get(id)
    if (!acc) {
      acc = this.repo.insert({
        account_id: id,
        vm_id: account.vm_id || null,
        email: account.email || null,
        max_concurrency: account.max_concurrency ?? this.defaultMax(),
        requests: 0,
        tokens_in: 0,
        tokens_out: 0,
        unified: {
          '5h': { utilization: 0, reset: null, status: 'active' },
          '7d': { utilization: 0, reset: null, status: 'active' },
          representative_claim: null,
          overage_status: null,
          updated_at: null,
        },
        last_blocked: null,
        last_error: null,
      })
    } else if (account.vm_id && acc.vm_id !== account.vm_id) {
      acc.vm_id = account.vm_id
      acc = this.repo.save(acc)
    }
    return acc
  }

  /**
   * Update from Anthropic response headers (unified OAuth stats).
   * headers: Headers | plain object (lower-cased keys preferred)
   */
  ingestHeaders(accountId, headers, usageBody = null) {
    const acc = this.ensure({ account_id: accountId })
    const h = normalizeHeaders(headers)

    const u5 = num(h['anthropic-ratelimit-unified-5h-utilization'])
    const u7 = num(h['anthropic-ratelimit-unified-7d-utilization'])
    if (u5 != null) {
      acc.unified['5h'].utilization = u5
      acc.unified['5h'].reset = h['anthropic-ratelimit-unified-5h-reset'] || null
      acc.unified['5h'].status = h['anthropic-ratelimit-unified-5h-status'] || statusFromUtil(u5)
    }
    if (u7 != null) {
      acc.unified['7d'].utilization = u7
      acc.unified['7d'].reset = h['anthropic-ratelimit-unified-7d-reset'] || null
      acc.unified['7d'].status = h['anthropic-ratelimit-unified-7d-status'] || statusFromUtil(u7)
    }
    const uOi = num(h['anthropic-ratelimit-unified-7d_oi-utilization'])
    if (uOi != null || h['anthropic-ratelimit-unified-7d_oi-status']) {
      acc.unified['7d_oi'] = {
        utilization: uOi ?? acc.unified['7d_oi']?.utilization ?? null,
        reset: h['anthropic-ratelimit-unified-7d_oi-reset'] || acc.unified['7d_oi']?.reset || null,
        status: h['anthropic-ratelimit-unified-7d_oi-status'] || statusFromUtil(uOi ?? 0),
      }
    }
    if (/seven_day_overage_included|7d_oi/i.test(String(h['anthropic-ratelimit-unified-representative-claim'] || ''))) {
      acc.unified['7d_oi'] = {
        ...(acc.unified['7d_oi'] || {}),
        claim: h['anthropic-ratelimit-unified-representative-claim'],
      }
    }
    if (h['anthropic-ratelimit-unified-representative-claim']) {
      acc.unified.representative_claim = h['anthropic-ratelimit-unified-representative-claim']
    }
    if (h['anthropic-ratelimit-unified-overage-status']) {
      acc.unified.overage_status = h['anthropic-ratelimit-unified-overage-status']
    }
    acc.unified.updated_at = new Date().toISOString()

    if (usageBody?.input_tokens != null) {
      acc.tokens_in += Number(usageBody.input_tokens) || 0
      acc.tokens_out += Number(usageBody.output_tokens) || 0
      acc.cache_read_tokens = (acc.cache_read_tokens || 0) +
        (Number(usageBody.cache_read_input_tokens ?? usageBody.cache_read_tokens) || 0)
      acc.cache_creation_tokens = (acc.cache_creation_tokens || 0) +
        (Number(usageBody.cache_creation_input_tokens ?? usageBody.cache_creation_tokens) || 0)
    }
    acc.requests += 1

    this.repo.addAllocation(accountId, {
      at: new Date().toISOString(),
      util_5h: acc.unified['5h'].utilization,
      util_7d: acc.unified['7d'].utilization,
      claim: acc.unified.representative_claim,
      tokens_in: usageBody?.input_tokens ?? null,
      tokens_out: usageBody?.output_tokens ?? null,
    })

    const saved = this.repo.save(acc)
    this._writeSessionWindow(saved)
    return saved
  }

  recordLastProbe(accountId, probe = {}) {
    if (!accountId) return null
    const acc = this.ensure({ account_id: accountId })
    acc.last_probe = {
      at: probe.at || new Date().toISOString(),
      ok: !!probe.ok,
      source: probe.source || 'test-chat',
      error: probe.error || null,
      transport: !!probe.transport,
      status: probe.status || null,
    }
    acc.unified.last_probe = acc.last_probe
    return this.repo.save(acc)
  }

  /**
   * CRS oauth/usage snapshot from the VM UID probe.
   * Fable weekly limit is stored separately and does not unschedulable the account.
   */
  ingestOAuthUsage(accountId, probe = {}) {
    const acc = this.ensure({ account_id: accountId })
    const w5 = probe.five_hour || {}
    const w7 = probe.seven_day || {}
    if (w5.utilization != null) {
      acc.unified['5h'].utilization = Number(w5.utilization) || 0
      acc.unified['5h'].reset = w5.resets_at || acc.unified['5h'].reset
      acc.unified['5h'].status = w5.status || acc.unified['5h'].status
    }
    if (w7.utilization != null) {
      acc.unified['7d'].utilization = Number(w7.utilization) || 0
      acc.unified['7d'].reset = w7.resets_at || acc.unified['7d'].reset
      acc.unified['7d'].status = w7.status || acc.unified['7d'].status
    }
    if (probe.seven_day_sonnet) {
      acc.unified.seven_day_sonnet = {
        utilization: probe.seven_day_sonnet.utilization ?? null,
        reset: probe.seven_day_sonnet.resets_at || null,
        status: probe.seven_day_sonnet.status || null,
      }
    }
    if (probe.extra_usage) acc.unified.overage_status = probe.extra_usage.status || acc.unified.overage_status
    acc.unified.extra_usage = probe.extra_usage || acc.unified.extra_usage || null
    const fableTransport = isFableTransportFailure(probe)
    const oi = probe.seven_day_oi || probe.seven_day_overage_included || probe.fable?.seven_day_oi
    const oiUtil = oi?.utilization != null ? Number(oi.utilization) : (probe.fable?.utilization != null ? Number(probe.fable.utilization) : null)
    const oiNorm = oiUtil != null && Number.isFinite(oiUtil) ? (oiUtil > 1.5 ? oiUtil / 100 : oiUtil) : null
    const oiRejected = ['rejected', 'rate_limited'].includes(String(oi?.status || '').toLowerCase())
      || (oiNorm != null && oiNorm >= 1)
    if (oiNorm != null || oi?.status || oi?.resets_at || oi?.reset || oiRejected) {
      acc.unified['7d_oi'] = {
        utilization: oiNorm ?? (oiRejected ? 1 : acc.unified['7d_oi']?.utilization ?? null),
        reset: oi?.resets_at || oi?.reset || probe.fable?.reset_at || acc.unified['7d_oi']?.reset || null,
        status: oiRejected ? 'rejected' : (oi?.status || (oiNorm != null ? statusFromUtil(oiNorm) : acc.unified['7d_oi']?.status || null)),
      }
    }
    const usageOk = probe.ok === true || (probe.usage_status > 0 && probe.usage_status < 400)
    if (probe.fable && !fableTransport) {
      const fableRevokeNoise = usageOk && (probe.fable.banned || probe.fable.status === 401
        || /revoked|oauth|authentication/i.test(String(probe.fable.error || '')))
      acc.unified.fable = {
        limited: oiRejected,
        banned: !!probe.fable.banned && !usageOk && (probe.usage_status === 401 || probe.usage_status === 403),
        plan_denied: !!probe.fable.plan_denied || fableRevokeNoise,
        ok: !!probe.fable.ok && !oiRejected,
        status: probe.fable.status || 0,
        reset: probe.fable.reset_at || acc.unified['7d_oi']?.reset || null,
        utilization: oiNorm ?? probe.fable.utilization ?? acc.unified['7d_oi']?.utilization ?? null,
        model: probe.fable.model || 'claude-fable-5',
        error: fableRevokeNoise ? 'plan_denied' : (probe.fable.error || null),
        probed_at: probe.probed_at || new Date().toISOString(),
      }
    }
    acc.unified.source = 'vm-oauth-usage'
    acc.unified.updated_at = new Date().toISOString()
    acc.last_probe = {
      at: probe.probed_at || new Date().toISOString(),
      ok: !!probe.ok,
      source: probe.source || 'vm-oauth-usage',
      error: probe.error || probe.usage_error || (usageOk ? null : probe.fable?.error) || null,
      transport: fableTransport,
    }
    acc.unified.last_probe = acc.last_probe
    const saved = this.repo.save(acc)
    this._writeSessionWindow(saved)
    return saved
  }

  /**
   * Official Claude Code stream-json `rate_limit_event` (not spoofed HTTP headers).
   * CLI does not emit utilization %; we store status + reset and keep prior utilization.
   */
  ingestCliRateLimit(accountId, rateLimitInfo, usageBody = null, { countRequest = null } = {}) {
    const acc = this.ensure({ account_id: accountId })
    const infos = Array.isArray(rateLimitInfo) ? rateLimitInfo : (rateLimitInfo ? [rateLimitInfo] : [])
    for (const info of infos) {
      if (!info || typeof info !== 'object') continue
      const typ = String(info.rateLimitType || info.rate_limit_type || '')
      const window = typ === 'seven_day' || typ === '7d' ? '7d'
        : typ === 'five_hour' || typ === '5h' ? '5h'
          : null
      if (window) {
        if (info.status) acc.unified[window].status = info.status
        const reset = info.resetsAt ?? info.resets_at
        if (reset != null) acc.unified[window].reset = epochToIso(reset)
        acc.unified[window].rate_limit_type = typ || null
      }
      if (info.overageStatus || info.overage_status) {
        acc.unified.overage_status = info.overageStatus || info.overage_status
      }
      acc.last_cli_rate_limit = { ...info, at: new Date().toISOString() }
    }
    acc.unified.updated_at = new Date().toISOString()
    acc.unified.source = 'claude_cli_rate_limit_event'

    const shouldCount = countRequest == null ? usageBody?.input_tokens != null : !!countRequest
    if (usageBody?.input_tokens != null) {
      acc.tokens_in += Number(usageBody.input_tokens) || 0
      acc.tokens_out += Number(usageBody.output_tokens) || 0
    }
    if (shouldCount) acc.requests += 1

    this.repo.addAllocation(accountId, {
      at: new Date().toISOString(),
      source: 'claude_cli',
      util_5h: acc.unified['5h'].utilization,
      util_7d: acc.unified['7d'].utilization,
      status_5h: acc.unified['5h'].status,
      status_7d: acc.unified['7d'].status,
      claim: acc.unified.representative_claim,
      tokens_in: usageBody?.input_tokens ?? null,
      tokens_out: usageBody?.output_tokens ?? null,
    })

    return this.repo.save(acc)
  }

  /**
   * Pre-flight check: can this account take another request?
   * @returns {{ ok: true } | { ok: false, reason, detail }}
   */
  canAccept(accountId) {
    const acc = this.ensure({ account_id: accountId })
    const ratio = Number(this.config.safety_ratio ?? 0.95)
    const inflight = this.inflight.get(accountId) || 0

    const limit = this.limitFor(acc)
    if (inflight >= limit) {
      return {
        ok: false,
        reason: 'concurrency_limit',
        detail: { inflight, max: limit, source: 'gateway' },
      }
    }

    const lastUsedAt = this._lastUsedAt(accountId)
    const w5 = effectiveRateWindow(acc.unified['5h'], {
      lastUsedAt,
      source: acc.unified.source,
      durationMs: WINDOW_5H_MS,
    })
    const w7 = effectiveRateWindow(acc.unified['7d'], {
      lastUsedAt,
      source: acc.unified.source,
      durationMs: WINDOW_7D_MS,
    })
    const u5 = Number(w5.utilization || 0)
    const u7 = Number(w7.utilization || 0)
    const s5 = String(w5.status || '')
    const s7 = String(w7.status || '')

    if (this.config.block_on_5h && (s5 === 'rejected' || s5 === 'rate_limited')) {
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', status: s5, source: 'claude_cli' }
      this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_5h_cli',
        detail: {
          status: s5,
          reset: w5.reset,
          message: `Official Claude Code rate_limit_event blocked 5h (${s5})`,
        },
      }
    }

    if (this.config.block_on_7d && (s7 === 'rejected' || s7 === 'rate_limited')) {
      acc.last_blocked = { at: new Date().toISOString(), window: '7d', status: s7, source: 'claude_cli' }
      this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_7d_cli',
        detail: {
          status: s7,
          reset: w7.reset,
          message: `Official Claude Code rate_limit_event blocked 7d (${s7})`,
        },
      }
    }

    if (this.config.block_on_5h && u5 >= ratio) {
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', utilization: u5 }
      this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_5h_safety',
        detail: {
          utilization: u5,
          safety_ratio: ratio,
          reset: w5.reset,
          message: `5h usage ${(u5 * 100).toFixed(1)}% ≥ safety ${(ratio * 100).toFixed(0)}%; request blocked to protect quota`,
        },
      }
    }

    if (this.config.block_on_7d && u7 >= ratio) {
      acc.last_blocked = { at: new Date().toISOString(), window: '7d', utilization: u7 }
      this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_7d_safety',
        detail: {
          utilization: u7,
          safety_ratio: ratio,
          reset: w7.reset,
          message: `7d usage ${(u7 * 100).toFixed(1)}% ≥ safety ${(ratio * 100).toFixed(0)}%; request blocked to protect weekly quota`,
        },
      }
    }

    return { ok: true, warn_5h: u5 >= (this.config.warn_ratio || 0.85), warn_7d: u7 >= (this.config.warn_ratio || 0.85) }
  }
  tryAcquire(accountId) {
    const gate = this.canAccept(accountId)
    if (!gate.ok) return gate
    const acc = this.ensure({ account_id: accountId })
    const inflight = this.inflight.get(accountId) || 0
    const limit = this.limitFor(acc)
    if (inflight >= limit) {
      return { ok: false, reason: 'concurrency_limit', detail: { inflight, max: limit, source: 'quota-reservation' } }
    }
    this.inflight.set(accountId, inflight + 1)
    return { ok: true }
  }

  /** sub2api 7d_oi: Fable-only window. Does not unschedulable the account. */
  fableWindowLimited(accountId) {
    const acc = this.repo.get(accountId)
    const status = String(acc?.unified?.['7d_oi']?.status || '').toLowerCase()
    return status === 'rejected' || status === 'rate_limited'
  }

  fableWindowResetAt(accountId) {
    const reset = this.repo.get(accountId)?.unified?.['7d_oi']?.reset
    if (!reset) return null
    const parsed = Date.parse(reset)
    return Number.isFinite(parsed) ? parsed : null
  }

  /** Experimental 50/50 weekly split. Off unless quota.weekly_split.enabled. */
  weeklySplitOf(accountId) {
    const cfg = weeklySplitConfig(this.config)
    const acc = this.repo.get(accountId)
    const u = acc?.unified || {}
    return computeWeeklySplit({
      enabled: cfg.enabled,
      fable_share: cfg.fable_share,
      utilization_7d: u['7d']?.utilization,
      utilization_7d_oi: u['7d_oi']?.utilization ?? u.fable?.utilization,
      status_7d_oi: u['7d_oi']?.status,
    })
  }

  weeklySplitResetAt(accountId, kind = 'regular') {
    const acc = this.repo.get(accountId)
    const key = kind === 'fable' ? '7d_oi' : '7d'
    const reset = acc?.unified?.[key]?.reset
    if (!reset) return null
    const parsed = Date.parse(reset)
    return Number.isFinite(parsed) ? parsed : null
  }

  acquire(accountId) {
    const n = (this.inflight.get(accountId) || 0) + 1
    this.inflight.set(accountId, n)
    return n
  }

  release(accountId) {
    const n = Math.max(0, (this.inflight.get(accountId) || 1) - 1)
    this.inflight.set(accountId, n)
    return n
  }

  _lastUsedAt(accountId) {
    try {
      const ms = Number(this.runtimeRepo?.get(accountId)?.last_used_at)
      if (Number.isFinite(ms) && ms > 0) return ms
    } catch {}
    try {
      const row = this.repo.recentAllocations(accountId, 1)?.[0]
      if (!row?.at) return null
      const parsed = Date.parse(row.at)
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  snapshot() {
    return {
      safety_ratio: this.config.safety_ratio,
      accounts: this.repo.list().map((a) => {
        const lastUsedAt = this._lastUsedAt(a.account_id)
        return {
          account_id: a.account_id,
          vm_id: a.vm_id,
          email: a.email,
          inflight: this.inflight.get(a.account_id) || 0,
          max_concurrency: a.max_concurrency,
          requests: a.requests,
          tokens_in: a.tokens_in,
          tokens_out: a.tokens_out,
          cache_read_tokens: a.cache_read_tokens || 0,
          cache_creation_tokens: a.cache_creation_tokens || 0,
          last_used_at: lastUsedAt,
          unified: applyEffectiveWindows(a.unified, { lastUsedAt, source: a.unified?.source }),
          last_blocked: a.last_blocked,
          recent_allocations: this.repo.recentAllocations(a.account_id, 5),
        }
      }),
    }
  }

  reloadConfig(config) {
    if (config?.quota) this.config = config.quota
    if (config?.concurrency) this.concurrency = config.concurrency
  }

  defaultMax() {
    const n = Number(this.concurrency?.default_max_per_account ?? this.concurrency?.default_key_concurrency ?? 20)
    return Number.isFinite(n) && n >= 0 ? n : 20
  }

  /** 0 = reject. Missing/invalid falls back to routing default. */
  limitFor(acc) {
    const n = Number(acc?.max_concurrency)
    if (Number.isFinite(n) && n >= 0) return n
    return this.defaultMax()
  }

  rebindToVm(accountUuid, vmId, { email = null } = {}) {
    if (!accountUuid || !vmId) return null
    const acc = this.ensure({ account_id: accountUuid, vm_id: vmId, email })
    if (!acc) return null
    if (acc.vm_id !== vmId || (email && acc.email !== email)) {
      acc.vm_id = vmId
      if (email) acc.email = email
      return this.repo.save(acc)
    }
    return acc
  }

  /**
   * A successful OAuth refresh proves the grant is live.
   * Drop leftover Fable / last_probe revoke strings so the panel resyncs.
   */
  clearGrantRevokeLeftover(accountId) {
    if (!accountId) return null
    const acc = this.repo.get(accountId)
    if (!acc) return null
    const revoke = /access token has been revoked|token has been revoked|oauth_revoked/i
    const u = acc.unified || {}
    const lp = u.last_probe || acc.last_probe || null
    const fb = u.fable || null
    let changed = false
    if (lp && revoke.test(String(lp.error || lp.message || ''))) {
      acc.last_probe = { ...lp, ok: true, error: null }
      u.last_probe = acc.last_probe
      changed = true
    }
    if (fb && (fb.banned || revoke.test(String(fb.error || '')))) {
      u.fable = {
        ...fb,
        banned: false,
        plan_denied: true,
        error: revoke.test(String(fb.error || '')) ? 'plan_denied' : (fb.error || null),
      }
      changed = true
    }
    if (!changed) return acc
    acc.unified = u
    acc.unified.updated_at = new Date().toISOString()
    return this.repo.save(acc)
  }

  setMaxConcurrency(accountId, n) {
    const acc = this.ensure({ account_id: accountId })
    if (!acc) return null
    acc.max_concurrency = Math.max(0, Math.min(256, Number(n) || 0))
    return this.repo.save(acc)
  }

  setMaxConcurrencyForVm(vmId, n) {
    const v = Math.max(0, Math.min(256, Number(n) || 0))
    const out = []
    for (const a of this.repo.list()) {
      if (a.vm_id === vmId || a.account_id === vmId) {
        a.max_concurrency = v
        out.push(this.repo.save(a))
      }
    }
    if (!out.length) out.push(this.setMaxConcurrency(vmId, v))
    return out
  }

  applyDefaultConcurrency(n, { skipIds } = {}) {
    const v = Math.max(0, Math.min(256, Number(n) || 0))
    const skip = new Set(skipIds || [])
    const out = []
    for (const a of this.repo.list()) {
      if (skip.has(a.account_id) || skip.has(a.vm_id)) continue
      a.max_concurrency = v
      out.push(this.repo.save(a))
    }
    return out
  }
}

function normalizeHeaders(headers) {
  if (!headers) return {}
  if (typeof headers.forEach === 'function') {
    const o = {}
    headers.forEach((v, k) => {
      o[String(k).toLowerCase()] = v
    })
    return o
  }
  const o = {}
  for (const [k, v] of Object.entries(headers)) o[String(k).toLowerCase()] = v
  return o
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function statusFromUtil(u) {
  if (u >= 1) return 'rate_limited'
  if (u >= 0.85) return 'warning'
  return 'active'
}

function epochToIso(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toISOString()
}

export function isFableTransportFailure(probe = {}) {
  const fable = probe.fable || {}
  if (fable.transport) return true
  if (probe.transportError || probe.transport) return true
  const status = Number(fable.status || 0)
  const err = String(fable.error || probe.error || probe.usage_error || '')
  if (status === 0 && /SOCKS|transport|worker_error|upstream_transport|refusing SOCKS|socket/i.test(err)) return true
  return (status === 502 || status === 0) && /SOCKS|greeting|reset by peer|transport|worker_error|upstream_transport|refusing SOCKS/i.test(err)
}
