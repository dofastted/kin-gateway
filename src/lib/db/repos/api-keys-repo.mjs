/**
 * api_keys repository — persistence for managed client API keys.
 * Pure SQL layer; business rules stay in lib/api-keys.mjs (ApiKeyStore).
 */

import { getDb } from '../database.mjs'

const COLUMNS = [
  'id', 'name', 'key', 'status', 'max_concurrency', 'quota_requests', 'quota_used',
  'rpm', 'expires_at', 'created_at', 'updated_at', 'last_used_at',
  'requests', 'tokens_in', 'tokens_out', 'key_hash', 'key_prefix', 'key_suffix',
]

function rowToRec(row) {
  if (!row) return null
  return { ...row }
}

export class ApiKeysRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM api_keys ORDER BY created_at')
    this._get = db.prepare('SELECT * FROM api_keys WHERE id = ?')
    this._getByKey = db.prepare('SELECT * FROM api_keys WHERE key = ?')
    this._getByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    this._insert = db.prepare(`
      INSERT INTO api_keys (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
    this._delete = db.prepare('DELETE FROM api_keys WHERE id = ?')
    this._recordUsage = db.prepare(`
      UPDATE api_keys SET
        requests = requests + 1,
        quota_used = quota_used + 1,
        tokens_in = tokens_in + ?,
        tokens_out = tokens_out + ?,
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `)
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  getById(id) {
    return rowToRec(this._get.get(id))
  }

  getByKey(key) {
    return rowToRec(this._getByKey.get(key))
  }

  getByHash(hash) {
    return rowToRec(this._getByHash.get(hash))
  }

  insert(rec) {
    this._insert.run(...COLUMNS.map((c) => rec[c] ?? null))
    return this.getById(rec.id)
  }

  /** Full-row update from a record object (id immutable). */
  update(rec) {
    const cols = COLUMNS.filter((c) => c !== 'id')
    const sql = `UPDATE api_keys SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
    this.db.prepare(sql).run(...cols.map((c) => rec[c] ?? null), rec.id)
    return this.getById(rec.id)
  }

  remove(id) {
    const info = this._delete.run(id)
    return info.changes > 0
  }

  recordUsage(id, { tokens_in = 0, tokens_out = 0 } = {}) {
    const now = new Date().toISOString()
    this._recordUsage.run(Number(tokens_in) || 0, Number(tokens_out) || 0, now, now, id)
    return this.getById(id)
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) c FROM api_keys').get().c
  }
}
