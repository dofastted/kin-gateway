/**
 * Configurable sticky / conversation-continuity routing (SQLite-backed).
 * Binds conversation key → account/VM for the TTL window.
 */

import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { StickyRepo } from '../db/repos/sticky-repo.mjs'

export class StickyRouter {
  constructor({ dataDir, db, config }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new StickyRepo(this.db)
    this.config = config?.sticky || { enabled: true, mode: 'conversation', ttl_seconds: 86400 }
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new StickyRepo(db)
  }

  extractKey(req, body = {}) {
    if (!this.config.enabled) return null
    const headers = req.headers || {}
    for (const k of this.config.header_keys || []) {
      const v = headers[k.toLowerCase()] || headers[k]
      if (v) return String(v)
    }
    for (const k of this.config.body_keys || []) {
      if (body?.[k]) return String(body[k])
    }
    // Stable hash of first user message + model as weak continuity (optional)
    if (this.config.mode === 'conversation_hash') {
      const msg = JSON.stringify(body?.messages?.[0] || body?.input || '')
      return crypto.createHash('sha256').update(msg).digest('hex').slice(0, 24)
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
    this.config = config?.sticky || this.config
  }
}
