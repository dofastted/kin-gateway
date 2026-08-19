import { getDb } from '../database.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function rowToState(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    status: row.status || 'unknown',
    priority: Number(row.priority) || 0,
    weight: Math.max(0, Number(row.weight) || 0),
    cooldown_until: row.cooldown_until == null ? null : Number(row.cooldown_until),
    cooldown_reason: row.cooldown_reason || null,
    model_states: parse(row.model_states_json, {}),
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
    credential_generation: Number(row.credential_generation) || 0,
    refresh_status: row.refresh_status || null,
    worker_heartbeat_at: row.worker_heartbeat_at == null ? null : Number(row.worker_heartbeat_at),
    worker_status: parse(row.worker_status_json),
    rate_limited_at: row.rate_limited_at == null ? null : Number(row.rate_limited_at),
    rate_limit_reset_at: row.rate_limit_reset_at == null ? null : Number(row.rate_limit_reset_at),
    overload_until: row.overload_until == null ? null : Number(row.overload_until),
    session_window_start: row.session_window_start == null ? null : Number(row.session_window_start),
    session_window_end: row.session_window_end == null ? null : Number(row.session_window_end),
    session_window_status: row.session_window_status || null,
    updated_at: row.updated_at,
  }
}

export class AccountRuntimeRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM account_runtime_states WHERE account_id = ?')
    this._list = db.prepare('SELECT * FROM account_runtime_states ORDER BY account_id')
    this._remove = db.prepare('DELETE FROM account_runtime_states WHERE account_id = ?')
    this._upsert = db.prepare(`
      INSERT INTO account_runtime_states (
        account_id, vm_id, status, priority, weight, cooldown_until,
        cooldown_reason, model_states_json, last_used_at, credential_generation,
        refresh_status, worker_heartbeat_at, worker_status_json,
        rate_limited_at, rate_limit_reset_at, overload_until,
        session_window_start, session_window_end, session_window_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        vm_id = excluded.vm_id,
        status = excluded.status,
        priority = excluded.priority,
        weight = excluded.weight,
        cooldown_until = excluded.cooldown_until,
        cooldown_reason = excluded.cooldown_reason,
        model_states_json = excluded.model_states_json,
        last_used_at = excluded.last_used_at,
        credential_generation = excluded.credential_generation,
        refresh_status = excluded.refresh_status,
        worker_heartbeat_at = excluded.worker_heartbeat_at,
        worker_status_json = excluded.worker_status_json,
        rate_limited_at = excluded.rate_limited_at,
        rate_limit_reset_at = excluded.rate_limit_reset_at,
        overload_until = excluded.overload_until,
        session_window_start = excluded.session_window_start,
        session_window_end = excluded.session_window_end,
        session_window_status = excluded.session_window_status,
        updated_at = excluded.updated_at
    `)
  }

  get(accountId) {
    return rowToState(this._get.get(accountId))
  }

  list() {
    return this._list.all().map(rowToState)
  }

  upsert(input = {}) {
    if (!input.account_id || !input.vm_id) return null
    const current = this.get(input.account_id) || {}
    const next = {
      ...current,
      ...input,
      status: input.status ?? current.status ?? 'unknown',
      priority: Number(input.priority ?? current.priority ?? 0),
      weight: Math.max(0, Number(input.weight ?? current.weight ?? 1)),
      model_states: input.model_states ?? current.model_states ?? {},
      updated_at: new Date().toISOString(),
    }
    this._upsert.run(
      next.account_id,
      next.vm_id,
      next.status,
      next.priority,
      next.weight,
      next.cooldown_until ?? null,
      next.cooldown_reason ?? null,
      JSON.stringify(next.model_states || {}),
      next.last_used_at ?? null,
      next.credential_generation ?? 0,
      next.refresh_status ?? null,
      next.worker_heartbeat_at ?? null,
      next.worker_status != null ? JSON.stringify(next.worker_status) : null,
      next.rate_limited_at ?? null,
      next.rate_limit_reset_at ?? null,
      next.overload_until ?? null,
      next.session_window_start ?? null,
      next.session_window_end ?? null,
      next.session_window_status ?? null,
      next.updated_at,
    )
    return this.get(next.account_id)
  }

  /**
   * Structured rate-limit / session-window write-through
   * (sub2api account.rate_limited_at / rate_limit_reset_at / overload_until /
   *  session_window_* counterpart). Only provided fields are updated.
   */
  updateWindow(accountId, {
    vmId = null,
    rateLimitedAt,
    rateLimitResetAt,
    overloadUntil,
    sessionWindowStart,
    sessionWindowEnd,
    sessionWindowStatus,
  } = {}) {
    const current = this.get(accountId) || {
      account_id: accountId,
      vm_id: vmId,
      model_states: {},
    }
    if (!current.vm_id && vmId) current.vm_id = vmId
    if (!current.vm_id) return null
    if (rateLimitedAt !== undefined) current.rate_limited_at = rateLimitedAt
    if (rateLimitResetAt !== undefined) current.rate_limit_reset_at = rateLimitResetAt
    if (overloadUntil !== undefined) current.overload_until = overloadUntil
    if (sessionWindowStart !== undefined) current.session_window_start = sessionWindowStart
    if (sessionWindowEnd !== undefined) current.session_window_end = sessionWindowEnd
    if (sessionWindowStatus !== undefined) current.session_window_status = sessionWindowStatus
    return this.upsert(current)
  }

  markCooldown(accountId, {
    vmId,
    until,
    reason,
    model = null,
    status = 'cooldown',
  } = {}) {
    const current = this.get(accountId) || {
      account_id: accountId,
      vm_id: vmId,
      model_states: {},
    }
    if (model) {
      current.model_states = { ...(current.model_states || {}) }
      current.model_states[model] = {
        status,
        cooldown_until: Number(until) || null,
        reason: reason || null,
        updated_at: new Date().toISOString(),
      }
    } else {
      current.status = status
      current.cooldown_until = Number(until) || null
      current.cooldown_reason = reason || null
      // Structured mirror of the protocol-level limit (sub2api account columns).
      if (/rate_limited|quota_exhausted/i.test(String(reason || ''))) {
        current.rate_limited_at = Date.now()
        current.rate_limit_reset_at = Number(until) || null
      }
      if (/overload/i.test(String(reason || ''))) {
        current.overload_until = Number(until) || null
      }
    }
    return this.upsert(current)
  }

  clearExpired(now = Date.now()) {
    for (const state of this.list()) {
      let changed = false
      if (state.cooldown_until && state.cooldown_until <= now) {
        state.status = 'ready'
        state.cooldown_until = null
        state.cooldown_reason = null
        changed = true
      }
      const models = { ...(state.model_states || {}) }
      for (const [model, modelState] of Object.entries(models)) {
        if (modelState?.cooldown_until && Number(modelState.cooldown_until) <= now) {
          delete models[model]
          changed = true
        }
      }
      if (changed) this.upsert({ ...state, model_states: models })
    }
  }

  remove(accountId) {
    return this._remove.run(accountId).changes > 0
  }
}
