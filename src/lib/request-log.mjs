/**
 * Request logging — sub2api UsageLog + access-log inspired (SQLite-backed).
 *
 * Modes:
 *   off    — no writes
 *   normal — summary row (tokens, status, duration, key/vm ids; no bodies)
 *   debug  — normal + full redacted request record (headers/body/hop_meta)
 *
 * Storage: `request_logs` (summaries) + `request_log_debug` (full records).
 * Optional JSONL mirror for external log shippers: KIN_REQUEST_LOG_JSONL=1
 * (writes the previous data/request-logs/YYYY-MM-DD.jsonl format alongside).
 *
 * Env: KIN_REQUEST_LOG_MODE=off|normal|debug (default normal)
 * Per-request override: X-Kin-Debug: 1 or X-Kin-Log: debug|normal|off
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { redactSecrets } from './security.mjs'
import { resolveStoreDb } from './db/database.mjs'
import { RequestLogsRepo } from './db/repos/request-logs-repo.mjs'

const MODES = new Set(['off', 'normal', 'debug'])

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function safeIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  const raw = xf || req.socket?.remoteAddress || ''
  return String(raw).slice(0, 45)
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return { empty: true }
  const messages = Array.isArray(body.messages) ? body.messages : null
  const roles = messages ? messages.map((m) => m?.role).filter(Boolean) : []
  let systemLen = 0
  if (typeof body.system === 'string') systemLen = body.system.length
  else if (Array.isArray(body.system)) {
    systemLen = body.system.reduce((n, b) => n + (typeof b === 'string' ? b.length : (b?.text || '').length), 0)
  }
  return {
    model: body.model || null,
    stream: !!body.stream,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? null,
    messages_count: messages ? messages.length : (body.input != null ? 1 : 0),
    roles,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    has_thinking: body.thinking != null,
    system_len: systemLen,
    top_level_keys: Object.keys(body).sort(),
  }
}

function redactHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase()
    if (key === 'authorization' || key === 'x-api-key' || key === 'cookie') {
      out[key] = '***REDACTED***'
    } else if (key === 'x-panel-token') {
      out[key] = '***REDACTED***'
    } else {
      out[key] = typeof v === 'string' ? v.slice(0, 512) : v
    }
  }
  return out
}


const SENSITIVE_KEY = /authorization|token|password|secret|cookie|api[_-]?key/i
const SNAP_MAX_STRING = 80
const SNAP_MAX_ARRAY = 24
const SNAP_MAX_DEPTH = 6
const SNAP_MAX_TOTAL = 12000

export function sanitizeRequestBodySnapshot(value, opts = {}, seen = new WeakSet(), depth = 0) {
  const maxString = opts.maxStringChars ?? SNAP_MAX_STRING
  const maxArray = opts.maxArrayItems ?? SNAP_MAX_ARRAY
  const maxDepth = opts.maxDepth ?? SNAP_MAX_DEPTH
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > maxString ? value.slice(0, maxString) + `…[${value.length}]` : value
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= maxDepth) return '[MaxDepth]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((v) => sanitizeRequestBodySnapshot(v, opts, seen, depth + 1))
    if (value.length > maxArray) items.push(`…[${value.length - maxArray} more]`)
    return items
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = '[REDACTED]'; continue }
    if (k === 'encrypted_content') { out[k] = `…[${String(v || '').length} chars]`; continue }
    if (k === 'tools' && Array.isArray(v)) {
      out[k] = v.slice(0, maxArray).map((t) => ({ type: t?.type || 'function', name: t?.name || t?.function?.name || null }))
      continue
    }
    out[k] = sanitizeRequestBodySnapshot(v, opts, seen, depth + 1)
  }
  let raw = ''
  try { raw = JSON.stringify(out) } catch { return out }
  if (raw.length > (opts.maxTotalChars ?? SNAP_MAX_TOTAL)) {
    return { _truncated: true, _chars: raw.length, preview: raw.slice(0, opts.maxTotalChars ?? SNAP_MAX_TOTAL) }
  }
  return out
}

function clampBody(obj, maxChars = 200_000) {
  let raw
  try {
    raw = redactSecrets(obj)
  } catch {
    raw = '{"error":"redact_failed"}'
  }
  if (raw.length <= maxChars) {
    try { return JSON.parse(raw) } catch { return { _raw: raw.slice(0, maxChars) } }
  }
  return { _truncated: true, _chars: raw.length, preview: raw.slice(0, maxChars) }
}

export function resolveLogMode(envMode, req) {
  const hdr = String(req?.headers?.['x-kin-log'] || '').trim().toLowerCase()
  if (MODES.has(hdr)) return hdr
  if (String(req?.headers?.['x-kin-debug'] || '') === '1') return 'debug'
  const base = String(envMode || 'normal').trim().toLowerCase()
  return MODES.has(base) ? base : 'normal'
}

export function newRequestId(req) {
  const incoming = String(req?.headers?.['x-request-id'] || '').trim()
  if (incoming && incoming.length <= 128) return incoming
  return crypto.randomUUID()
}

export class RequestLogStore {
  constructor({
    dataDir,
    db,
    mode = process.env.KIN_REQUEST_LOG_MODE || 'normal',
    maxDebugBodyChars = Number(process.env.KIN_REQUEST_LOG_DEBUG_CHARS || 200000),
    retainDays = Number(process.env.KIN_REQUEST_LOG_RETAIN_DAYS || 7),
    jsonlMirror = process.env.KIN_REQUEST_LOG_JSONL === '1',
  } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data')
    this.db = resolveStoreDb({ db, dataDir: this.dataDir })
    this.repo = new RequestLogsRepo(this.db)
    this.root = path.join(this.dataDir, 'request-logs')
    this.mode = MODES.has(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'normal'
    this.maxDebugBodyChars = Number.isFinite(maxDebugBodyChars) ? maxDebugBodyChars : 200000
    this.retainDays = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : 7
    this.jsonlMirror = !!jsonlMirror
    this._mem = [] // recent normal summaries for panel hot path
    this._memMax = 200
  }

  setConfig({ mode, retainDays } = {}) {
    if (mode != null) {
      const m = String(mode).trim().toLowerCase()
      if (MODES.has(m)) this.mode = m
    }
    if (retainDays != null) {
      const n = Number(retainDays)
      if (Number.isFinite(n) && n > 0) this.retainDays = n
    }
    return this.snapshot()
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {
    this._mem = []
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new RequestLogsRepo(db)
    this._mem = []
  }

  start(req, { protocol = null, pathName = null } = {}) {
    const requestId = newRequestId(req)
    try { req.headers = req.headers || {} } catch {}
    const mode = resolveLogMode(this.mode, req)
    return {
      request_id: requestId,
      mode,
      t0: Date.now(),
      protocol,
      path: pathName || req.url || '',
      method: req.method || 'POST',
      ip: safeIp(req),
      user_agent: String(req.headers?.['user-agent'] || '').slice(0, 512),
      headers: mode === 'debug' ? redactHeaders(req.headers) : null,
    }
  }

  /**
   * Write normal summary always (unless off).
   * Write debug full record when mode===debug.
   */
  finish(ctx, extra = {}) {
    if (!ctx || ctx.mode === 'off') return null
    const duration_ms = Math.max(0, Date.now() - (ctx.t0 || Date.now()))
    const summary = {
      id: 'log_' + crypto.randomBytes(6).toString('hex'),
      request_id: ctx.request_id,
      ts: new Date().toISOString(),
      log_mode: ctx.mode,
      method: ctx.method,
      path: ctx.path,
      protocol: extra.protocol || ctx.protocol || null,
      model: extra.model || null,
      stream: !!extra.stream,
      status: extra.status ?? null,
      duration_ms,
      api_key_kind: extra.api_key_kind || null,
      api_key_id: extra.api_key_id || null,
      vm_id: extra.vm_id || null,
      account_id: extra.account_id || null,
      workspace: extra.workspace || null,
      input_tokens: extra.input_tokens ?? extra.usage?.input_tokens ?? null,
      output_tokens: extra.output_tokens ?? extra.usage?.output_tokens ?? null,
      error_code: extra.error_code || null,
      error_message: extra.error_message ? String(extra.error_message).slice(0, 300) : null,
      user_agent: ctx.user_agent,
      ip: ctx.ip,
      has_tools: extra.has_tools ?? null,
      via: extra.via || extra.hop_meta?.via || null,
      cache_read_tokens: extra.cache_read_tokens ?? extra.usage?.cache_read_input_tokens ?? extra.usage?.cache_read_tokens ?? null,
      cache_creation_tokens: extra.cache_creation_tokens ?? extra.usage?.cache_creation_input_tokens ?? extra.usage?.cache_creation_tokens ?? null,
      attempt_count: extra.attempt_count ?? null,
      final_state: extra.final_state || null,
      final_account_id: extra.final_account_id || extra.account_id || null,
    }

    try { this.repo.insertSummaryIfAbsent(summary) } catch {}
    if (this.jsonlMirror) this._appendJsonl(summary)
    this._mem.push(summary)
    if (this._mem.length > this._memMax) this._mem = this._mem.slice(-this._memMax)

    if (ctx.mode === 'debug') {
      const debugRec = {
        ...summary,
        headers: ctx.headers,
        inbound_summary: extra.inbound_summary || summarizeBody(extra.inbound_body),
        request_body_snapshot: extra.inbound_body != null ? sanitizeRequestBodySnapshot(extra.inbound_body) : null,
        inbound_body: extra.inbound_body != null ? clampBody(extra.inbound_body, this.maxDebugBodyChars) : null,
        hop_meta: extra.hop_meta || null,
        via: extra.via || extra.hop_meta?.via || null,
        upstream_status: extra.upstream_status ?? null,
        outbound_summary: extra.outbound_summary || null,
        outbound_body: extra.outbound_body != null ? clampBody(extra.outbound_body, this.maxDebugBodyChars) : null,
      }
      try { this.repo.insertDebug(summary.request_id || summary.id, summary.ts, debugRec) } catch {}
    }
    return summary
  }

  /** Optional legacy JSONL mirror for external log collectors. */
  _appendJsonl(summary) {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const file = path.join(this.root, `${dayKey()}.jsonl`)
      fs.appendFileSync(file, JSON.stringify(summary) + '\n', { mode: 0o600 })
    } catch {}
  }

  listNormal({ limit = 50, ...filters } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    const hasFilters = Object.values(filters).some((v) => v != null && v !== '')
    if (!hasFilters && this._mem.length >= n) {
      return this._mem.slice(-n).reverse()
    }
    return this.repo.query({ limit: n, ...filters }).items
  }

  /** Filtered + paginated query with total (panel). */
  queryNormal(opts = {}) {
    return this.repo.query(opts)
  }

  /** Aggregated stats for charts. */
  aggregate(opts = {}) {
    return this.repo.aggregate(opts)
  }

  totals() {
    return this.repo.totals()
  }

  listDebug({ limit = 20 } = {}) {
    return this.repo.listDebug({ limit })
  }

  getDebug(requestId) {
    if (!requestId) return null
    return this.repo.getDebug(requestId)
  }

  snapshot() {
    return {
      mode: this.mode,
      retain_days: this.retainDays,
      recent_normal: this._mem.length,
      backend: 'sqlite',
      jsonl_mirror: this.jsonlMirror,
      total_rows: (() => { try { return this.repo.count() } catch { return null } })(),
    }
  }

  /** Retention: delete rows older than retainDays (+ legacy jsonl files). */
  cleanup() {
    try { this.repo.cleanup(this.retainDays) } catch {}
    // best-effort: also age out legacy/mirrored jsonl + debug dirs on disk
    const cutoff = Date.now() - this.retainDays * 86400_000
    try {
      if (fs.existsSync(this.root)) {
        for (const name of fs.readdirSync(this.root)) {
          if (!/^\d{4}-\d{2}-\d{2}/.test(name)) continue
          const dayMs = Date.parse(name.slice(0, 10) + 'T00:00:00Z')
          if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
          fs.rmSync(path.join(this.root, name), { recursive: true, force: true })
        }
        const dbgRoot = path.join(this.root, 'debug')
        if (fs.existsSync(dbgRoot)) {
          for (const name of fs.readdirSync(dbgRoot)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
            const dayMs = Date.parse(name + 'T00:00:00Z')
            if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
            fs.rmSync(path.join(dbgRoot, name), { recursive: true, force: true })
          }
        }
      }
    } catch {}
  }
}

export { summarizeBody, redactHeaders, clampBody }
