/**
 * Request logging — sub2api UsageLog + access-log inspired.
 *
 * Modes:
 *   off    — no writes
 *   normal — summary JSONL (tokens, status, duration, key/vm ids; no bodies)
 *   debug  — normal + full redacted request record (headers/body/hop_meta)
 *
 * Env: KIN_REQUEST_LOG_MODE=off|normal|debug (default normal)
 * Per-request override: X-Kin-Debug: 1 or X-Kin-Log: debug|normal|off
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { redactSecrets } from './security.mjs'

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
    mode = process.env.KIN_REQUEST_LOG_MODE || 'normal',
    maxDebugBodyChars = Number(process.env.KIN_REQUEST_LOG_DEBUG_CHARS || 200000),
    retainDays = Number(process.env.KIN_REQUEST_LOG_RETAIN_DAYS || 7),
  } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data')
    this.root = path.join(this.dataDir, 'request-logs')
    this.debugRoot = path.join(this.root, 'debug')
    this.mode = MODES.has(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'normal'
    this.maxDebugBodyChars = Number.isFinite(maxDebugBodyChars) ? maxDebugBodyChars : 200000
    this.retainDays = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : 7
    this._mem = [] // recent normal summaries for panel
    this._memMax = 200
    fs.mkdirSync(this.debugRoot, { recursive: true })
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
    }

    this._appendNormal(summary)
    this._mem.push(summary)
    if (this._mem.length > this._memMax) this._mem = this._mem.slice(-this._memMax)

    if (ctx.mode === 'debug') {
      const debugRec = {
        ...summary,
        headers: ctx.headers,
        inbound_summary: extra.inbound_summary || summarizeBody(extra.inbound_body),
        inbound_body: extra.inbound_body != null ? clampBody(extra.inbound_body, this.maxDebugBodyChars) : null,
        hop_meta: extra.hop_meta || null,
        upstream_status: extra.upstream_status ?? null,
        outbound_summary: extra.outbound_summary || null,
        outbound_body: extra.outbound_body != null ? clampBody(extra.outbound_body, this.maxDebugBodyChars) : null,
      }
      this._writeDebug(debugRec)
    }
    return summary
  }

  _appendNormal(summary) {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const file = path.join(this.root, `${dayKey()}.jsonl`)
      fs.appendFileSync(file, JSON.stringify(summary) + '\n', { mode: 0o600 })
    } catch {}
  }

  _writeDebug(rec) {
    try {
      const day = dayKey()
      const dir = path.join(this.debugRoot, day)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${rec.request_id || rec.id}.json`)
      fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 })
    } catch {}
  }

  listNormal({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    // newest first: memory then file tail
    if (this._mem.length) {
      return this._mem.slice(-n).reverse()
    }
    return this._readJsonlTail(path.join(this.root, `${dayKey()}.jsonl`), n)
  }

  listDebug({ limit = 20, day = null } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    const d = day || dayKey()
    const dir = path.join(this.debugRoot, d)
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
    const out = []
    for (const f of files.slice(0, n)) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      } catch {}
    }
    return out
  }

  getDebug(requestId, { day = null } = {}) {
    if (!requestId) return null
    const days = day ? [day] : [dayKey(), dayKey(new Date(Date.now() - 86400_000))]
    for (const d of days) {
      const file = path.join(this.debugRoot, d, `${requestId}.json`)
      if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
      }
    }
    return null
  }

  _readJsonlTail(file, n) {
    try {
      if (!fs.existsSync(file)) return []
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      return lines.slice(-n).reverse().map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    } catch {
      return []
    }
  }

  snapshot() {
    return {
      mode: this.mode,
      retain_days: this.retainDays,
      recent_normal: this._mem.length,
      today_file: path.join(this.root, `${dayKey()}.jsonl`),
    }
  }

  /** Best-effort retention: drop old day folders/files. */
  cleanup() {
    const cutoff = Date.now() - this.retainDays * 86400_000
    try {
      for (const name of fs.readdirSync(this.root)) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(name)) continue
        const dayMs = Date.parse(name.slice(0, 10) + 'T00:00:00Z')
        if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
        const p = path.join(this.root, name)
        fs.rmSync(p, { recursive: true, force: true })
      }
      for (const name of fs.readdirSync(this.debugRoot)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
        const dayMs = Date.parse(name + 'T00:00:00Z')
        if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
        fs.rmSync(path.join(this.debugRoot, name), { recursive: true, force: true })
      }
    } catch {}
  }
}

export { summarizeBody, redactHeaders, clampBody }
