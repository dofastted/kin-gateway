/**
 * Configurable sticky / conversation-continuity routing (SQLite-backed).
 * Binds conversation key → account/VM for the TTL window.
 */

import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { StickyRepo } from '../db/repos/sticky-repo.mjs'

export const DEFAULT_STICKY_HEADER_KEYS = [
  'x-session-id',
  'x-conversation-id',
  'x-claude-code-session-id',
  'x-client-request-id',
  'session-id',
  'thread-id',
]

export const DEFAULT_STICKY_BODY_KEYS = [
  'conversation_id',
  'session_id',
  'thread_id',
  'prompt_cache_key',
]

function mergeStickyConfig(config) {
  const sticky = config?.sticky || {}
  return {
    enabled: sticky.enabled !== false,
    mode: sticky.mode || 'conversation',
    ttl_seconds: sticky.ttl_seconds || 86400,
    header_keys: Array.isArray(sticky.header_keys) && sticky.header_keys.length
      ? sticky.header_keys
      : DEFAULT_STICKY_HEADER_KEYS,
    body_keys: Array.isArray(sticky.body_keys) && sticky.body_keys.length
      ? sticky.body_keys
      : DEFAULT_STICKY_BODY_KEYS,
  }
}

export class StickyRouter {
  constructor({ dataDir, db, config }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new StickyRepo(this.db)
    this.config = mergeStickyConfig(config)
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new StickyRepo(db)
  }

  isolateKey(raw, req = null) {
    const id = req?.apiKeyRecord?.id
    if (id == null || id === '') return String(raw)
    return `k${id}:${raw}`
  }

  extractKey(req, body = {}) {
    if (!this.config.enabled) return null
    const headers = req.headers || {}
    for (const k of this.config.header_keys || ['x-session-id']) {
      const v = headers[k.toLowerCase()] || headers[k]
      if (v) return this.isolateKey(String(v), req)
    }
    for (const k of this.config.body_keys || []) {
      if (body?.[k]) return this.isolateKey(String(body[k]), req)
    }
    // Stable hash of first user message + model as weak continuity (optional)
    if (this.config.mode === 'conversation_hash') {
      const msg = JSON.stringify(body?.messages?.[0] || body?.input || '')
      return this.isolateKey(crypto.createHash('sha256').update(msg).digest('hex').slice(0, 24), req)
    }
    return null
  }

  /** @returns {{ accountId: string, vmId: string } | null } */
  resolve(key) {
    if (!key || !this.config.enabled) return null
    this._purge()
    const ent = this.repo.get(key)
    if (!ent) return null
    if (Date.now() > ent.expires_at) {
      this.repo.remove(key)
      return null
    }
    return { accountId: ent.account_id, vmId: ent.vm_id, sessionId: ent.session_id || null, key }
  }

  bind(key, { accountId, vmId, sessionId = null }) {
    if (!key || !this.config.enabled) return
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const prev = this.repo.get(key) || {}
    this.repo.upsert(key, {
      account_id: accountId,
      vm_id: vmId,
      session_id: sessionId || prev.session_id || null,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
      hits: (prev.hits || 0) + 1,
    })
  }

  unbind(key) {
    if (!key) return
    this.repo.remove(key)
  }

  unbindByAccount({ accountId = null, vmId = null } = {}) {
    return this.repo.removeByAccount({ accountId, vmId })
  }

  _purge() {
    this.repo.purgeExpired(Date.now())
  }

  stats() {
    this._purge()
    const sessions = this.repo.all()
    return {
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      active_sessions: Object.keys(sessions).length,
      sessions,
    }
  }

  reloadConfig(config) {
    this.config = mergeStickyConfig(config)
  }
}
