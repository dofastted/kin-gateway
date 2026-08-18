/**
 * Multi API-key store (sub2api-inspired, SQLite-backed).
 *
 * Fields aligned to sub2api basics:
 *   name, status, expires_at, quota (+ used), rate windows → rpm,
 *   concurrency (per-key, sub2api puts this on User).
 *
 * Master env key KIN_API_KEY is separate and unlimited.
 * Managed keys live in the `api_keys` table (see lib/db/).
 * Transient state (inflight concurrency, RPM buckets) stays in memory,
 * mirroring sub2api's Redis-transient split.
 */

import crypto from 'node:crypto'
import { resolveStoreDb } from './db/database.mjs'
import { ApiKeysRepo } from './db/repos/api-keys-repo.mjs'

const KEY_PREFIX = 'sk-kin-'

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function nowIso() {
  return new Date().toISOString()
}

export function generateApiKey(prefix = KEY_PREFIX) {
  return prefix + crypto.randomBytes(32).toString('hex')
}

export function maskApiKey(key) {
  const s = String(key || '')
  if (s.length <= 12) return s.slice(0, 4) + '…'
  return s.slice(0, 8) + '…' + s.slice(-4)
}

export function publicKeyView(rec, { reveal = false } = {}) {
  if (!rec) return null
  return {
    id: rec.id,
    name: rec.name,
    key: reveal ? rec.key : maskApiKey(rec.key),
    key_prefix: String(rec.key || '').slice(0, 10),
    status: rec.status,
    max_concurrency: rec.max_concurrency,
    quota_requests: rec.quota_requests,
    quota_used: rec.quota_used,
    rpm: rec.rpm,
    expires_at: rec.expires_at,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    last_used_at: rec.last_used_at,
    requests: rec.requests || 0,
    tokens_in: rec.tokens_in || 0,
    tokens_out: rec.tokens_out || 0,
    inflight: undefined, // filled by store.snapshot
  }
}

function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

export class ApiKeyStore {
  constructor({ dataDir, db } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ApiKeysRepo(this.db)
    this.inflight = new Map() // id → count
    this.rpmBuckets = new Map() // id → number[] timestamps ms
  }

  /** Re-read from DB (no-op cache-wise; kept for API compat + post-restore). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new ApiKeysRepo(db)
  }

  list({ reveal = false } = {}) {
    return this.repo.list().map((k) => {
      const v = publicKeyView(k, { reveal })
      v.inflight = this.inflight.get(k.id) || 0
      return v
    })
  }

  getById(id) {
    return this.repo.getById(id)
  }

  authenticate(token) {
    if (!token) return { ok: false, reason: 'missing' }
    for (const rec of this.repo.list()) {
      if (timingSafeEqualStr(token, rec.key)) {
        return { ok: true, record: rec }
      }
    }
    return { ok: false, reason: 'invalid' }
  }

  create(input = {}) {
    const name = String(input.name || 'default').trim().slice(0, 100) || 'default'
    let key = input.key ? String(input.key).trim() : generateApiKey()
    if (key.length < 16) throw Object.assign(new Error('key too short'), { code: 'key_too_short' })
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw Object.assign(new Error('key has invalid characters'), { code: 'key_invalid' })
    }
    if (this.repo.getByKey(key)) {
      throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
    }

    const rec = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'),
      name,
      key,
      status: 'active',
      max_concurrency: clampInt(input.max_concurrency, 0, 128, 2),
      quota_requests: clampInt(input.quota_requests, 0, 1e9, 0),
      quota_used: 0,
      rpm: clampInt(input.rpm, 0, 1e6, 0),
      expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_used_at: null,
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
    }
    if (rec.expires_at && Number.isNaN(Date.parse(rec.expires_at))) {
      throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
    }
    return this.repo.insert(rec)
  }

  update(id, patch = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    if (patch.name != null) rec.name = String(patch.name).trim().slice(0, 100) || rec.name
    if (patch.status != null) {
      const st = String(patch.status).toLowerCase()
      if (!['active', 'disabled'].includes(st)) {
        throw Object.assign(new Error('invalid status'), { code: 'invalid_status' })
      }
      rec.status = st
    }
    if (patch.max_concurrency != null) rec.max_concurrency = clampInt(patch.max_concurrency, 0, 128, rec.max_concurrency)
    if (patch.quota_requests != null) rec.quota_requests = clampInt(patch.quota_requests, 0, 1e9, rec.quota_requests)
    if (patch.rpm != null) rec.rpm = clampInt(patch.rpm, 0, 1e6, rec.rpm)
    if (patch.expires_at === null) rec.expires_at = null
    else if (patch.expires_at != null) {
      const iso = new Date(patch.expires_at).toISOString()
      if (Number.isNaN(Date.parse(iso))) throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
      rec.expires_at = iso
    }
    if (patch.reset_quota === true) rec.quota_used = 0
    rec.updated_at = nowIso()
    return this.repo.update(rec)
  }

  remove(id) {
    const removed = this.repo.remove(id)
    if (!removed) return false
    this.inflight.delete(id)
    this.rpmBuckets.delete(id)
    return true
  }

  _expired(rec, now = Date.now()) {
    if (!rec.expires_at) return false
    return Date.parse(rec.expires_at) <= now
  }

  _rpmCount(id, now = Date.now()) {
    const windowMs = 60_000
    let arr = this.rpmBuckets.get(id) || []
    arr = arr.filter((t) => now - t < windowMs)
    this.rpmBuckets.set(id, arr)
    return arr.length
  }

  /**
   * Pre-flight gate for a managed key. Does not acquire concurrency.
   * @returns {{ ok: true } | { ok: false, code, message, status }}
   */
  canAccept(rec, now = Date.now()) {
    if (!rec) return { ok: false, code: 'invalid_api_key', message: 'Invalid credentials', status: 401 }
    if (rec.status !== 'active') {
      return { ok: false, code: 'api_key_disabled', message: 'API key is disabled', status: 403 }
    }
    if (this._expired(rec, now)) {
      return { ok: false, code: 'api_key_expired', message: 'API key has expired', status: 403 }
    }
    if (rec.quota_requests > 0 && rec.quota_used >= rec.quota_requests) {
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key quota exhausted',
        status: 429,
        detail: { quota_requests: rec.quota_requests, quota_used: rec.quota_used },
      }
    }
    if (rec.rpm > 0) {
      const n = this._rpmCount(rec.id, now)
      if (n >= rec.rpm) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key rate limit exceeded (${rec.rpm}/min)`,
          status: 429,
          detail: { rpm: rec.rpm, current: n },
        }
      }
    }
    const inflight = this.inflight.get(rec.id) || 0
    if (rec.max_concurrency > 0 && inflight >= rec.max_concurrency) {
      return {
        ok: false,
        code: 'api_key_concurrency_limit',
        message: `API key concurrency limit (${rec.max_concurrency})`,
        status: 429,
        detail: { inflight, max: rec.max_concurrency },
      }
    }
    return { ok: true }
  }

  acquire(rec, now = Date.now()) {
    const gate = this.canAccept(rec, now)
    if (!gate.ok) return gate
    const id = rec.id
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1)
    const arr = this.rpmBuckets.get(id) || []
    arr.push(now)
    this.rpmBuckets.set(id, arr)
    return { ok: true }
  }

  release(recOrId) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!id) return
    const n = (this.inflight.get(id) || 0) - 1
    if (n <= 0) this.inflight.delete(id)
    else this.inflight.set(id, n)
  }

  recordUsage(recOrId, usage = {}) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!this.repo.getById(id)) return null
    return this.repo.recordUsage(id, {
      tokens_in: Number(usage.input_tokens) || Number(usage.tokens_in) || 0,
      tokens_out: Number(usage.output_tokens) || Number(usage.tokens_out) || 0,
    })
  }

  snapshot() {
    const keys = this.list({ reveal: false })
    return {
      total: keys.length,
      active: keys.filter((k) => k.status === 'active').length,
      keys,
    }
  }
}
