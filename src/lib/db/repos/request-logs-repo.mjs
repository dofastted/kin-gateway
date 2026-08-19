/**
 * request_logs + request_log_debug repository — sub2api UsageLog counterpart.
 * Normal summaries (always, unless mode=off) and full redacted debug records.
 */

import { getDb } from '../database.mjs'

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
    try { return JSON.parse(row.record_json) } catch { return null }
  }

  listDebug({ limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    return this._listDebug.all(n).map((r) => {
      try { return JSON.parse(r.record_json) } catch { return null }
    }).filter(Boolean)
  }

  /**
   * Filtered, paginated query over summaries (newest first).
   * @returns {{ items: object[], total: number }}
   */
  query({
    limit = 50, offset = 0, api_key_id = null, vm_id = null, account_id = null,
    model = null, status = null, protocol = null, since = null, until = null, q = null,
  } = {}) {
    const where = []
    const params = []
    if (api_key_id) { where.push('api_key_id = ?'); params.push(api_key_id) }
    if (vm_id) { where.push('vm_id = ?'); params.push(vm_id) }
    if (account_id) { where.push('account_id = ?'); params.push(account_id) }
    if (model) { where.push('model = ?'); params.push(model) }
    if (protocol) { where.push('protocol = ?'); params.push(protocol) }
    if (status != null && status !== '') {
      if (String(status) === 'error') where.push('(status >= 400 OR error_code IS NOT NULL)')
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
    const total = this.db.prepare(`SELECT COUNT(*) c FROM request_logs ${cond}`).get(...params).c
    const items = this.db
      .prepare(`SELECT * FROM request_logs ${cond} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, n, off)
      .map(fromRow)
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
             SUM(CASE WHEN status >= 400 OR error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
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
             SUM(CASE WHEN status >= 400 OR error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
      FROM request_logs
    `).get()
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
