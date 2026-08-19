/**
 * accounts + account_allocations repository.
 * Persists per-account Claude usage/quota state (5h/7d unified windows)
 * and the allocation ledger (was a 50-entry ring buffer in JSON).
 */

import { getDb } from '../database.mjs'

const MAX_ALLOCATIONS_PER_ACCOUNT = 50

function parse(json, fallback = null) {
  if (json == null) return fallback
  try { return JSON.parse(json) } catch { return fallback }
}

function rowToAccount(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    email: row.email,
    max_concurrency: row.max_concurrency,
    requests: row.requests || 0,
    tokens_in: row.tokens_in || 0,
    tokens_out: row.tokens_out || 0,
    cache_read_tokens: row.cache_read_tokens || 0,
    cache_creation_tokens: row.cache_creation_tokens || 0,
    unified: parse(row.unified_json, {
      '5h': { utilization: 0, reset: null, status: 'active' },
      '7d': { utilization: 0, reset: null, status: 'active' },
      representative_claim: null,
      overage_status: null,
      updated_at: null,
    }),
    last_blocked: parse(row.last_blocked_json),
    last_cli_rate_limit: parse(row.last_cli_rate_limit_json),
    updated_at: row.updated_at,
  }
}

export class AccountsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM accounts WHERE account_id = ?')
    this._list = db.prepare('SELECT * FROM accounts ORDER BY account_id')
    this._insert = db.prepare(`
      INSERT INTO accounts (account_id, vm_id, email, max_concurrency, requests, tokens_in, tokens_out,
                            cache_read_tokens, cache_creation_tokens,
                            unified_json, last_blocked_json, last_cli_rate_limit_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._update = db.prepare(`
      UPDATE accounts SET vm_id = ?, email = ?, max_concurrency = ?, requests = ?, tokens_in = ?, tokens_out = ?,
                          cache_read_tokens = ?, cache_creation_tokens = ?,
                          unified_json = ?, last_blocked_json = ?, last_cli_rate_limit_json = ?, updated_at = ?
      WHERE account_id = ?
    `)
    this._insertAlloc = db.prepare(`
      INSERT INTO account_allocations (account_id, at, source, util_5h, util_7d, status_5h, status_7d, claim, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._trimAlloc = db.prepare(`
      DELETE FROM account_allocations WHERE account_id = ? AND id NOT IN (
        SELECT id FROM account_allocations WHERE account_id = ? ORDER BY id DESC LIMIT ?
      )
    `)
    this._recentAlloc = db.prepare(`
      SELECT * FROM account_allocations WHERE account_id = ? ORDER BY id DESC LIMIT ?
    `)
    this._removeAllocs = db.prepare('DELETE FROM account_allocations WHERE account_id = ?')
    this._remove = db.prepare('DELETE FROM accounts WHERE account_id = ?')
  }

  get(accountId) {
    return rowToAccount(this._get.get(accountId))
  }

  list() {
    return this._list.all().map(rowToAccount)
  }

  /** Insert if missing, returns stored account. */
  insert(acc) {
    this._insert.run(
      acc.account_id,
      acc.vm_id ?? null,
      acc.email ?? null,
      acc.max_concurrency ?? 2,
      acc.requests ?? 0,
      acc.tokens_in ?? 0,
      acc.tokens_out ?? 0,
      acc.cache_read_tokens ?? 0,
      acc.cache_creation_tokens ?? 0,
      JSON.stringify(acc.unified ?? null),
      acc.last_blocked != null ? JSON.stringify(acc.last_blocked) : null,
      acc.last_cli_rate_limit != null ? JSON.stringify(acc.last_cli_rate_limit) : null,
      acc.updated_at ?? new Date().toISOString(),
    )
    return this.get(acc.account_id)
  }

  /** Full-row save of a mutated account object. */
  save(acc) {
    this._update.run(
      acc.vm_id ?? null,
      acc.email ?? null,
      acc.max_concurrency ?? 2,
      acc.requests ?? 0,
      acc.tokens_in ?? 0,
      acc.tokens_out ?? 0,
      acc.cache_read_tokens ?? 0,
      acc.cache_creation_tokens ?? 0,
      JSON.stringify(acc.unified ?? null),
      acc.last_blocked != null ? JSON.stringify(acc.last_blocked) : null,
      acc.last_cli_rate_limit != null ? JSON.stringify(acc.last_cli_rate_limit) : null,
      new Date().toISOString(),
      acc.account_id,
    )
    return this.get(acc.account_id)
  }

  remove(accountId) {
    this._removeAllocs.run(accountId)
    const info = this._remove.run(accountId)
    return info.changes > 0
  }

  addAllocation(accountId, alloc, { max = MAX_ALLOCATIONS_PER_ACCOUNT } = {}) {
    this._insertAlloc.run(
      accountId,
      alloc.at || new Date().toISOString(),
      alloc.source ?? null,
      alloc.util_5h ?? null,
      alloc.util_7d ?? null,
      alloc.status_5h ?? null,
      alloc.status_7d ?? null,
      alloc.claim ?? null,
      alloc.tokens_in ?? null,
      alloc.tokens_out ?? null,
    )
    this._trimAlloc.run(accountId, accountId, max)
  }

  recentAllocations(accountId, limit = 5) {
    return this._recentAlloc.all(accountId, limit).reverse().map((r) => ({
      at: r.at,
      source: r.source ?? undefined,
      util_5h: r.util_5h,
      util_7d: r.util_7d,
      status_5h: r.status_5h ?? undefined,
      status_7d: r.status_7d ?? undefined,
      claim: r.claim,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
    }))
  }

  allocationCount(accountId) {
    return this.db.prepare('SELECT COUNT(*) c FROM account_allocations WHERE account_id = ?').get(accountId).c
  }
}
