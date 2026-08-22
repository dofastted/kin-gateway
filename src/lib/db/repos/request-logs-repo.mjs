/**
 * request_logs + request_log_debug repository — sub2api UsageLog counterpart.
 * Normal summaries (always, unless mode=off) and full redacted debug records.
 */

import { getDb } from '../database.mjs'
import { collectErrors, enrichLogRow, ignoredErrorSqlList, slaOkErrorSqlList } from '../../admin/error-class.mjs'
import { calculateCost, emptyCostBucket, shanghaiDayStartIso } from '../../admin/pricing.mjs'

const IGNORED_CODES_SQL = ignoredErrorSqlList()
const SLA_OK_CODES_SQL = slaOkErrorSqlList()
const ERROR_PRED = `(status >= 400 OR (error_code IS NOT NULL AND error_code != '' AND error_code NOT IN (${IGNORED_CODES_SQL})))`
const SUCCESS_PRED = `(status < 400 AND (error_code IS NULL OR error_code = '' OR error_code IN (${IGNORED_CODES_SQL})))`
const SLA_OK_PRED = `(status = 429 OR (error_code IS NOT NULL AND error_code != '' AND error_code IN (${SLA_OK_CODES_SQL})))`
const SLA_SUCCESS_PRED = `(${SUCCESS_PRED} OR ${SLA_OK_PRED})`
const SLA_ERROR_PRED = `(${ERROR_PRED} AND NOT (${SLA_OK_PRED}))`

const SUMMARY_COLUMNS = [
  'id', 'request_id', 'ts', 'log_mode', 'method', 'path', 'protocol', 'model',
  'stream', 'status', 'duration_ms', 'api_key_kind', 'api_key_id', 'vm_id',
  'account_id', 'workspace', 'input_tokens', 'output_tokens', 'error_code',
  'error_message', 'user_agent', 'ip', 'has_tools',
  'via', 'cache_read_tokens', 'cache_creation_tokens',
  'cache_creation_5m_tokens', 'cache_creation_1h_tokens',
  'requested_model', 'upstream_model', 'model_mismatch',
  'first_token_ms', 'stop_reason',
  'attempt_count', 'final_state', 'final_account_id',
  'input_cost', 'output_cost', 'cache_read_cost', 'cache_creation_cost',
  'total_cost', 'pricing_model',
]

function toRow(rec) {
  return SUMMARY_COLUMNS.map((c) => {
    let v = rec[c]
    if (c === 'stream') return rec.stream ? 1 : 0
    if (c === 'has_tools') return rec.has_tools == null ? null : (rec.has_tools ? 1 : 0)
    return v ?? null
  })
}

function fromRow(row) {
  if (!row) return null
  return {
    ...row,
    stream: !!row.stream,
    has_tools: row.has_tools == null ? null : !!row.has_tools,
  }
}

function timeCond(since, until) {
  const where = []
  const params = []
  if (since) { where.push('ts >= ?'); params.push(new Date(since).toISOString()) }
  if (until) { where.push('ts <= ?'); params.push(new Date(until).toISOString()) }
  return { cond: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function filterCond({ since = null, until = null, vmId = null, accountId = null } = {}) {
  const { cond, params } = timeCond(since, until)
  const parts = cond ? [cond.replace(/^WHERE /, '')] : []
  if (vmId) {
    parts.push('vm_id = ?')
    params.push(vmId)
  }
  if (accountId) {
    parts.push('(account_id = ? OR final_account_id = ?)')
    params.push(accountId, accountId)
  }
  return { cond: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/** Same percentile pick as concurrent-test / sub2api ops cards. */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[i]
}

export function summarizeLatency(values) {
  const s = (values || [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (!s.length) {
    return { samples: 0, p50_ms: null, p90_ms: null, p95_ms: null, p99_ms: null, avg_ms: null, max_ms: null }
  }
  return {
    samples: s.length,
    p50_ms: percentile(s, 0.5),
    p90_ms: percentile(s, 0.9),
    p95_ms: percentile(s, 0.95),
    p99_ms: percentile(s, 0.99),
    avg_ms: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    max_ms: s[s.length - 1],
  }
}

export class RequestLogsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._insert = db.prepare(`
      INSERT INTO request_logs (${SUMMARY_COLUMNS.join(', ')})
      VALUES (${SUMMARY_COLUMNS.map(() => '?').join(', ')})
    `)
    this._insertIfAbsent = db.prepare(`
      INSERT OR IGNORE INTO request_logs (${SUMMARY_COLUMNS.join(', ')})
      VALUES (${SUMMARY_COLUMNS.map(() => '?').join(', ')})
    `)
    this._insertDebug = db.prepare(`
      INSERT INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET ts = excluded.ts, record_json = excluded.record_json
    `)
    this._insertDebugIfAbsent = db.prepare(`
      INSERT OR IGNORE INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)
    `)
    this._getDebug = db.prepare('SELECT record_json FROM request_log_debug WHERE request_id = ?')
    this._listDebug = db.prepare('SELECT record_json FROM request_log_debug ORDER BY ts DESC LIMIT ?')
  }

  insertSummary(rec) {
    this._insert.run(...toRow(rec))
    return rec
  }

  /** INSERT OR IGNORE (legacy import path). @returns true when inserted */
  insertSummaryIfAbsent(rec) {
    return this._insertIfAbsent.run(...toRow(rec)).changes > 0
  }

  insertDebug(requestId, ts, record) {
    this._insertDebug.run(requestId, ts || new Date().toISOString(), JSON.stringify(record))
  }

  insertDebugIfAbsent(requestId, ts, record) {
    return this._insertDebugIfAbsent.run(requestId, ts || new Date().toISOString(), JSON.stringify(record)).changes > 0
  }

  getDebug(requestId) {
    const row = this._getDebug.get(requestId)
    if (!row) return null
    try { return enrichLogRow(JSON.parse(row.record_json)) } catch { return null }
  }

  listDebug({ limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    return this._listDebug.all(n).map((r) => {
      try { return enrichLogRow(JSON.parse(r.record_json)) } catch { return null }
    }).filter(Boolean)
  }

  /**
   * Filtered, paginated query over summaries (newest first).
   * @returns {{ items: object[], total: number }}
   */
  query({
    limit = 50, offset = 0, api_key_id = null, vm_id = null, account_id = null,
    model = null, status = null, protocol = null, since = null, until = null, q = null,
    error_class = null,
  } = {}) {
    const where = []
    const params = []
    if (api_key_id) { where.push('api_key_id = ?'); params.push(api_key_id) }
    if (vm_id) { where.push('vm_id = ?'); params.push(vm_id) }
    if (account_id) { where.push('account_id = ?'); params.push(account_id) }
    if (model) { where.push('model = ?'); params.push(model) }
    if (protocol) { where.push('protocol = ?'); params.push(protocol) }
    if (error_class && (status == null || status === '')) status = 'error'
    if (status != null && status !== '') {
      if (String(status) === 'error') where.push(ERROR_PRED)
      else if (String(status) === 'ok') where.push('(status < 400 AND status IS NOT NULL)')
      else { where.push('status = ?'); params.push(Number(status)) }
    }
    if (since) { where.push('ts >= ?'); params.push(new Date(since).toISOString()) }
    if (until) { where.push('ts <= ?'); params.push(new Date(until).toISOString()) }
    if (q) {
      where.push('(path LIKE ? OR error_code LIKE ? OR error_message LIKE ? OR request_id LIKE ?)')
      const like = `%${String(q).slice(0, 100)}%`
      params.push(like, like, like, like)
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    const off = Math.max(0, Number(offset) || 0)
    if (error_class) {
      const rows = this.db
        .prepare(`SELECT * FROM request_logs ${cond} ORDER BY ts DESC, id DESC LIMIT 2000`)
        .all(...params)
        .map(fromRow)
        .map(enrichLogRow)
        .filter((row) => row.error_class === error_class)
      return { items: rows.slice(off, off + n), total: rows.length }
    }
    const total = this.db.prepare(`SELECT COUNT(*) c FROM request_logs ${cond}`).get(...params).c
    const items = this.db
      .prepare(`SELECT * FROM request_logs ${cond} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, n, off)
      .map(fromRow)
      .map(enrichLogRow)
    return { items, total }
  }

  /**
   * Aggregate stats bucketed by day or hour (dashboard/usage charts).
   * @returns {Array<{bucket, requests, errors, input_tokens, output_tokens, avg_duration_ms}>}
   */
  aggregate({ since = null, until = null, bucket = 'day' } = {}) {
    const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d'
    const where = []
    const params = []
    if (since) { where.push('ts >= ?'); params.push(new Date(since).toISOString()) }
    if (until) { where.push('ts <= ?'); params.push(new Date(until).toISOString()) }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.db.prepare(`
      SELECT strftime('${fmt}', ts) AS bucket,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(total_cost), 0) AS total_cost,
             CAST(AVG(duration_ms) AS INTEGER) AS avg_duration_ms,
             CAST(AVG(first_token_ms) AS INTEGER) AS avg_first_token_ms
      FROM request_logs ${cond}
      GROUP BY bucket ORDER BY bucket
    `).all(...params)
  }

  /** Grand totals (dashboard db_totals). */
  totals() {
    return this.db.prepare(`
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(input_cost), 0) AS input_cost,
             COALESCE(SUM(output_cost), 0) AS output_cost,
             COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
             COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
             COALESCE(SUM(total_cost), 0) AS total_cost
      FROM request_logs
    `).get()
  }

  /**
   * Fill official-standard cost on rows that predate the billing columns.
   * Idempotent; skips rows that already have total_cost.
   */
  backfillMissingCosts({ limit = 4000 } = {}) {
    const rows = this.db.prepare(`
      SELECT id, model, upstream_model, requested_model,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             cache_creation_5m_tokens, cache_creation_1h_tokens
      FROM request_logs
      WHERE total_cost IS NULL
      LIMIT ?
    `).all(Math.max(1, Math.min(20000, Number(limit) || 4000)))
    if (!rows.length) return 0
    const upd = this.db.prepare(`
      UPDATE request_logs
         SET input_cost = ?, output_cost = ?, cache_read_cost = ?,
             cache_creation_cost = ?, total_cost = ?, pricing_model = ?
       WHERE id = ?
    `)
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        const model = r.upstream_model || r.model || r.requested_model
        const c = calculateCost(r, model)
        upd.run(
          c.known ? c.input_cost : 0,
          c.known ? c.output_cost : 0,
          c.known ? c.cache_read_cost : 0,
          c.known ? c.cache_creation_cost : 0,
          c.known ? c.total_cost : 0,
          c.pricing_key,
          r.id,
        )
      }
      this.db.exec('COMMIT')
    } catch (e) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw e
    }
    return rows.length
  }

  _costSelect(cond, params) {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(input_cost), 0) AS input_cost,
        COALESCE(SUM(output_cost), 0) AS output_cost,
        COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
        COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
        COALESCE(SUM(total_cost), 0) AS total_cost
      FROM request_logs ${cond}
    `).get(...params)
    return {
      requests: Number(row?.requests || 0),
      input_tokens: Number(row?.input_tokens || 0),
      output_tokens: Number(row?.output_tokens || 0),
      cache_read_tokens: Number(row?.cache_read_tokens || 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens || 0),
      input_cost: Number(row?.input_cost || 0),
      output_cost: Number(row?.output_cost || 0),
      cache_read_cost: Number(row?.cache_read_cost || 0),
      cache_creation_cost: Number(row?.cache_creation_cost || 0),
      total_cost: Number(row?.total_cost || 0),
    }
  }

  costByAccount({ since = null, until = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const rows = this.db.prepare(`
      SELECT
        COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—') AS account_id,
        vm_id,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(input_cost), 0) AS input_cost,
        COALESCE(SUM(output_cost), 0) AS output_cost,
        COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
        COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
        COALESCE(SUM(total_cost), 0) AS total_cost
      FROM request_logs ${cond}
      GROUP BY 1, vm_id
      ORDER BY total_cost DESC
    `).all(...params)
    return rows.map((r) => ({
      account_id: r.account_id,
      vm_id: r.vm_id || null,
      requests: Number(r.requests || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      input_cost: Number(r.input_cost || 0),
      output_cost: Number(r.output_cost || 0),
      cache_read_cost: Number(r.cache_read_cost || 0),
      cache_creation_cost: Number(r.cache_creation_cost || 0),
      total_cost: Number(r.total_cost || 0),
    }))
  }

  /** Official-standard cost grouped by upstream model for one credential / slot. */
  costByModel({ vmId = null, accountId = null, since = null, until = null } = {}) {
    const { cond, params } = filterCond({ since, until, vmId, accountId })
    const rows = this.db.prepare(`
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '—') AS model,
             COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(input_cost), 0) AS input_cost,
             COALESCE(SUM(output_cost), 0) AS output_cost,
             COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
             COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
             COALESCE(SUM(total_cost), 0) AS total_cost
      FROM request_logs ${cond}
      GROUP BY 1
      ORDER BY total_cost DESC, requests DESC
      LIMIT 24
    `).all(...params)
    return rows.map((r) => ({
      model: r.model,
      requests: Number(r.requests || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      input_cost: Number(r.input_cost || 0),
      output_cost: Number(r.output_cost || 0),
      cache_read_cost: Number(r.cache_read_cost || 0),
      cache_creation_cost: Number(r.cache_creation_cost || 0),
      total_cost: Number(r.total_cost || 0),
    }))
  }

  /** Official-standard totals: all-time + Shanghai calendar today + per account. */
  billingStats() {
    try { this.backfillMissingCosts() } catch {}
    const todayStart = shanghaiDayStartIso()
    const total = this._costSelect('', [])
    const today = this._costSelect('WHERE ts >= ?', [todayStart])
    const fiveHStart = new Date(Date.now() - 5 * 3600_000).toISOString()
    const sevenDStart = new Date(Date.now() - 7 * 86400_000).toISOString()
    const accountsTotal = this.costByAccount()
    const accountsToday = this.costByAccount({ since: todayStart })
    const accounts5h = this.costByAccount({ since: fiveHStart })
    const accounts7d = this.costByAccount({ since: sevenDStart })
    const keyOf = (a) => a.account_id + '\0' + (a.vm_id || '')
    const todayById = new Map(accountsToday.map((a) => [keyOf(a), a]))
    const fiveById = new Map(accounts5h.map((a) => [keyOf(a), a]))
    const sevenById = new Map(accounts7d.map((a) => [keyOf(a), a]))
    const accounts = accountsTotal.map((a) => {
      const t = todayById.get(keyOf(a)) || emptyCostBucket()
      const w = fiveById.get(keyOf(a)) || emptyCostBucket()
      const w7 = sevenById.get(keyOf(a)) || emptyCostBucket()
      return {
        ...a,
        today: { ...t },
        window_5h: { ...w },
        window_7d: { ...w7 },
        today_cost: Number(t.total_cost || 0),
        today_requests: Number(t.requests || 0),
        today_input_tokens: Number(t.input_tokens || 0),
        today_output_tokens: Number(t.output_tokens || 0),
        today_cache_read_tokens: Number(t.cache_read_tokens || 0),
        today_cache_creation_tokens: Number(t.cache_creation_tokens || 0),
        today_input_cost: Number(t.input_cost || 0),
        today_output_cost: Number(t.output_cost || 0),
        today_cache_cost: Number(t.cache_read_cost || 0) + Number(t.cache_creation_cost || 0),
        window_5h_cost: Number(w.total_cost || 0),
        window_5h_requests: Number(w.requests || 0),
        window_5h_tokens: Number(w.input_tokens || 0) + Number(w.output_tokens || 0),
        window_5h_input_tokens: Number(w.input_tokens || 0),
        window_5h_output_tokens: Number(w.output_tokens || 0),
        window_5h_cache_read_tokens: Number(w.cache_read_tokens || 0),
        window_5h_cache_creation_tokens: Number(w.cache_creation_tokens || 0),
        window_5h_input_cost: Number(w.input_cost || 0),
        window_5h_output_cost: Number(w.output_cost || 0),
        window_5h_cache_cost: Number(w.cache_read_cost || 0) + Number(w.cache_creation_cost || 0),
        window_7d_cost: Number(w7.total_cost || 0),
        window_7d_requests: Number(w7.requests || 0),
        window_7d_tokens: Number(w7.input_tokens || 0) + Number(w7.output_tokens || 0),
      }
    })
    return {
      source: 'anthropic-official',
      currency: 'USD',
      today_start: todayStart,
      window_5h_start: fiveHStart,
      window_7d_start: sevenDStart,
      today,
      window_5h: this._costSelect('WHERE ts >= ?', [fiveHStart]),
      window_7d: this._costSelect('WHERE ts >= ?', [sevenDStart]),
      total,
      accounts,
    }
  }

  /**
   * Windowed ops snapshot aligned with sub2api overview cards:
   * SLA / error / 429 / 503, QPS·TPS, duration + first_token percentiles, per-model.
   */
  windowStats({ since = null, until = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS status_429,
        SUM(CASE WHEN status = 529 THEN 1 ELSE 0 END) AS status_529,
        SUM(CASE WHEN status = 503 THEN 1 ELSE 0 END) AS status_503,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_requests,
        SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_samples,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(total_cost), 0) AS total_cost
      FROM request_logs ${cond}
    `).get(...params)
    const requests = Number(counts?.requests || 0)
    const success = Number(counts?.success || 0)
    const errors = Number(counts?.errors || 0)
    const inputTokens = Number(counts?.input_tokens || 0)
    const outputTokens = Number(counts?.output_tokens || 0)
    const tokens = inputTokens + outputTokens

    const startMs = since ? Date.parse(since) : null
    const endMs = until ? Date.parse(until) : Date.now()
    const windowSeconds = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(1, (endMs - startMs) / 1000)
      : Math.max(1, requests)

    const minuteRows = this.db.prepare(`
      SELECT strftime('%Y-%m-%dT%H:%M', ts) AS minute,
             COUNT(*) AS requests,
             COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) AS tokens
      FROM request_logs ${cond}
      GROUP BY minute
    `).all(...params)
    const peakReq = minuteRows.reduce((m, r) => Math.max(m, Number(r.requests || 0)), 0)
    const peakTok = minuteRows.reduce((m, r) => Math.max(m, Number(r.tokens || 0)), 0)
    const lastMinute = minuteRows.length ? minuteRows[minuteRows.length - 1] : null

    const ttftWhere = cond ? `${cond} AND first_token_ms IS NOT NULL` : 'WHERE first_token_ms IS NOT NULL'
    const durWhere = cond ? `${cond} AND duration_ms IS NOT NULL` : 'WHERE duration_ms IS NOT NULL'
    const ttfts = this.db.prepare(`SELECT first_token_ms AS v FROM request_logs ${ttftWhere}`).all(...params).map((r) => r.v)
    const durs = this.db.prepare(`SELECT duration_ms AS v FROM request_logs ${durWhere}`).all(...params).map((r) => r.v)

    const byModel = this.db.prepare(`
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), '—') AS model,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_samples,
             CAST(AVG(first_token_ms) AS INTEGER) AS avg_first_token_ms,
             CAST(AVG(duration_ms) AS INTEGER) AS avg_duration_ms
      FROM request_logs ${cond}
      GROUP BY 1
      ORDER BY requests DESC
      LIMIT 12
    `).all(...params)

    return {
      since: since ? new Date(since).toISOString() : null,
      until: until ? new Date(until).toISOString() : new Date().toISOString(),
      window_seconds: Math.round(windowSeconds),
      requests,
      success,
      errors,
      sla: requests ? success / requests : 1,
      error_rate: requests ? errors / requests : 0,
      status_429: Number(counts?.status_429 || 0),
      status_529: Number(counts?.status_529 || 0),
      status_503: Number(counts?.status_503 || 0),
      stream_requests: Number(counts?.stream_requests || 0),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: Number(counts?.cache_read_tokens || 0),
      cache_creation_tokens: Number(counts?.cache_creation_tokens || 0),
      total_cost: Number(counts?.total_cost || 0),
      qps: {
        current: lastMinute ? Number(lastMinute.requests || 0) / 60 : 0,
        peak: peakReq / 60,
        avg: requests / windowSeconds,
      },
      tps: {
        current: lastMinute ? Number(lastMinute.tokens || 0) / 60 : 0,
        peak: peakTok / 60,
        avg: tokens / windowSeconds,
      },
      duration: summarizeLatency(durs),
      ttft: summarizeLatency(ttfts),
      by_model: byModel.map((r) => ({
        model: r.model,
        requests: Number(r.requests || 0),
        errors: Number(r.errors || 0),
        ttft_samples: Number(r.ttft_samples || 0),
        avg_first_token_ms: r.avg_first_token_ms ?? null,
        avg_duration_ms: r.avg_duration_ms ?? null,
      })),
      error_collection: this.errorCollection({ since, until }),
    }
  }

  errorCollection({ since = null, until = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const errCond = cond
      ? `${cond} AND ${ERROR_PRED}`
      : `WHERE ${ERROR_PRED}`
    const rows = this.db.prepare(`
      SELECT ts, request_id, status, error_code, error_message, model, upstream_model, vm_id
      FROM request_logs ${errCond}
      ORDER BY ts DESC, id DESC
      LIMIT 2000
    `).all(...params)
    return collectErrors(rows)
  }

  /** Retention: delete rows older than retainDays. @returns deleted counts */
  cleanup(retainDays = 7) {
    const cutoff = new Date(Date.now() - retainDays * 86400_000).toISOString()
    const a = this.db.prepare('DELETE FROM request_logs WHERE ts < ?').run(cutoff).changes
    const b = this.db.prepare('DELETE FROM request_log_debug WHERE ts < ?').run(cutoff).changes
    try { this.db.exec('PRAGMA optimize') } catch {}
    return { request_logs: a, request_log_debug: b }
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) c FROM request_logs').get().c
  }
}
