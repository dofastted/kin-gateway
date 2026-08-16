/**
 * Configurable sticky / conversation-continuity routing.
 * Binds conversation key → account/VM for the TTL window.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export class StickyRouter {
  constructor({ dataDir, config }) {
    this.dataDir = dataDir
    this.config = config?.sticky || { enabled: true, mode: 'conversation', ttl_seconds: 86400 }
    this.file = path.join(dataDir, 'sticky-map.json')
    this.map = this._load()
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return { sessions: {} }
    }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2))
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
    const ent = this.map.sessions[key]
    if (!ent) return null
    if (Date.now() > ent.expires_at) {
      delete this.map.sessions[key]
      this._save()
      return null
    }
    return { accountId: ent.account_id, vmId: ent.vm_id, key }
  }

  bind(key, { accountId, vmId }) {
    if (!key || !this.config.enabled) return
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    this.map.sessions[key] = {
      account_id: accountId,
      vm_id: vmId,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
      hits: (this.map.sessions[key]?.hits || 0) + 1,
    }
    this._save()
  }

  _purge() {
    const now = Date.now()
    let dirty = false
    for (const [k, v] of Object.entries(this.map.sessions)) {
      if (now > v.expires_at) {
        delete this.map.sessions[k]
        dirty = true
      }
    }
    if (dirty) this._save()
  }

  stats() {
    this._purge()
    return {
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      active_sessions: Object.keys(this.map.sessions).length,
      sessions: this.map.sessions,
    }
  }

  reloadConfig(config) {
    this.config = config?.sticky || this.config
  }
}
