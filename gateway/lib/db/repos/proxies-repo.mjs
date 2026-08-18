/**
 * proxies repository — SOCKS5 pool rows + pool config in settings.
 * The ProxyPool keeps its working set in memory (probe loop mutates it);
 * this repo is the persistence surface: loadAll / replaceAll.
 */

import { getDb, withTransaction } from '../database.mjs'
import { SettingsRepo } from './settings-repo.mjs'

const CONFIG_KEY = 'proxy_pool_config'

const COLUMNS = [
  'id', 'scheme', 'host', 'port', 'username', 'password', 'raw', 'status',
  'enabled', 'bound_vm_id', 'consecutive_failures', 'latency_ms',
  'last_probe_at', 'last_error', 'created_at',
]

function rowToProxy(row) {
  if (!row) return null
  return { ...row, enabled: !!row.enabled }
}

export class ProxiesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._all = db.prepare('SELECT * FROM proxies ORDER BY created_at, id')
    this._clear = db.prepare('DELETE FROM proxies')
    this._insert = db.prepare(`
      INSERT INTO proxies (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
  }

  loadAll() {
    return this._all.all().map(rowToProxy)
  }

  replaceAll(proxies = []) {
    withTransaction(this.db, () => {
      this._clear.run()
      for (const p of proxies) {
        this._insert.run(...COLUMNS.map((c) => {
          const v = p[c]
          if (c === 'enabled') return v === false ? 0 : 1
          return v ?? null
        }))
      }
    })
  }

  getConfig(fallback = null) {
    return this.settings.get(CONFIG_KEY, fallback)
  }

  setConfig(config) {
    return this.settings.set(CONFIG_KEY, config)
  }
}
