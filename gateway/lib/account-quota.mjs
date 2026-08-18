/**
 * Per-account Claude usage quota tracker (SQLite-backed).
 * Uses anthropic-ratelimit-unified-* headers (OAuth beta) for 5h / 7d utilization.
 * Soft-blocks at safety_ratio (default 0.95) before hard rate limit.
 *
 * Persistent state → `accounts` + `account_allocations` tables.
 * Transient state (inflight counters) stays in memory.
 */

import { resolveStoreDb } from './db/database.mjs'
import { AccountsRepo } from './db/repos/accounts-repo.mjs'

export class AccountQuota {
  constructor({ dataDir, db, config, accounts }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new AccountsRepo(this.db)
    this.config = config?.quota || { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true }
    this.concurrency = config?.concurrency || { default_max_per_account: 2 }
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

  ensure(account) {
    const id = account.account_id || account.account_uuid || account.id
    if (!id) return
    let acc = this.repo.get(id)
    if (!acc) {
      acc = this.repo.insert({
        account_id: id,
        vm_id: account.vm_id || null,
        email: account.email || null,
        max_concurrency: account.max_concurrency || this.concurrency.default_max_per_account || 2,
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

    return this.repo.save(acc)
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

    if (inflight >= (acc.max_concurrency || 2)) {
      return {
        ok: false,
        reason: 'concurrency_limit',
        detail: { inflight, max: acc.max_concurrency },
      }
    }

    const u5 = Number(acc.unified['5h'].utilization || 0)
    const u7 = Number(acc.unified['7d'].utilization || 0)
    const s5 = String(acc.unified['5h'].status || '')
    const s7 = String(acc.unified['7d'].status || '')

    if (this.config.block_on_5h && (s5 === 'rejected' || s5 === 'rate_limited')) {
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', status: s5, source: 'claude_cli' }
      this.repo.save(acc)
      return {
        ok: false,
        reason: 'quota_5h_cli',
        detail: {
          status: s5,
          reset: acc.unified['5h'].reset,
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
          reset: acc.unified['7d'].reset,
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
          reset: acc.unified['5h'].reset,
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
          reset: acc.unified['7d'].reset,
          message: `7d usage ${(u7 * 100).toFixed(1)}% ≥ safety ${(ratio * 100).toFixed(0)}%; request blocked to protect weekly quota`,
        },
      }
    }

    return { ok: true, warn_5h: u5 >= (this.config.warn_ratio || 0.85), warn_7d: u7 >= (this.config.warn_ratio || 0.85) }
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

  snapshot() {
    return {
      safety_ratio: this.config.safety_ratio,
      accounts: this.repo.list().map((a) => ({
        account_id: a.account_id,
        vm_id: a.vm_id,
        email: a.email,
        inflight: this.inflight.get(a.account_id) || 0,
        max_concurrency: a.max_concurrency,
        requests: a.requests,
        tokens_in: a.tokens_in,
        tokens_out: a.tokens_out,
        unified: a.unified,
        last_blocked: a.last_blocked,
        recent_allocations: this.repo.recentAllocations(a.account_id, 5),
      })),
    }
  }

  reloadConfig(config) {
    if (config?.quota) this.config = config.quota
    if (config?.concurrency) this.concurrency = config.concurrency
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
