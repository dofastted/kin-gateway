/**
 * Per-account Claude usage quota tracker.
 * Uses anthropic-ratelimit-unified-* headers (OAuth beta) for 5h / 7d utilization.
 * Soft-blocks at safety_ratio (default 0.95) before hard rate limit.
 */

import fs from 'node:fs'
import path from 'node:path'

export class AccountQuota {
  constructor({ dataDir, config, accounts }) {
    this.dataDir = dataDir
    this.config = config?.quota || { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true }
    this.concurrency = config?.concurrency || { default_max_per_account: 2 }
    this.file = path.join(dataDir, 'account-stats.json')
    this.state = this._load()
    this.inflight = new Map() // accountId → count
    // seed accounts
    for (const a of accounts || []) this.ensure(a)
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return { accounts: {} }
    }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }

  ensure(account) {
    const id = account.account_id || account.account_uuid || account.id
    if (!id) return
    if (!this.state.accounts[id]) {
      this.state.accounts[id] = {
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
        allocations: [],
        last_blocked: null,
        last_error: null,
      }
      this._save()
    } else if (account.vm_id) {
      this.state.accounts[id].vm_id = account.vm_id
    }
    return this.state.accounts[id]
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

    // allocation log (ring buffer max 50)
    acc.allocations.push({
      at: new Date().toISOString(),
      util_5h: acc.unified['5h'].utilization,
      util_7d: acc.unified['7d'].utilization,
      claim: acc.unified.representative_claim,
      tokens_in: usageBody?.input_tokens ?? null,
      tokens_out: usageBody?.output_tokens ?? null,
    })
    if (acc.allocations.length > 50) acc.allocations = acc.allocations.slice(-50)

    this._save()
    return acc
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

    if (this.config.block_on_5h && u5 >= ratio) {
      acc.last_blocked = { at: new Date().toISOString(), window: '5h', utilization: u5 }
      this._save()
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
      this._save()
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
      accounts: Object.values(this.state.accounts).map((a) => ({
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
        recent_allocations: (a.allocations || []).slice(-5),
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
