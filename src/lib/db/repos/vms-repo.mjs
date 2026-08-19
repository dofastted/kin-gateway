/**
 * vms repository — VM records + OAuth credential mirror.
 *
 * The `vms/*.json` files remain the runtime single-writer surface
 * (persistOauthToVm / CLI seed). Every file write is mirrored here
 * (see lib/vm-db-sync.mjs), so the database always holds the full
 * credential set and a DB-only backup can restore everything.
 *
 * With KIN_DB_SECRET set, credential columns and the full vm_json are
 * AES-256-GCM encrypted at rest (encrypted=1).
 */

import { getDb } from '../database.mjs'
import { SettingsRepo } from './settings-repo.mjs'
import { maybeEncrypt, maybeDecrypt, encryptionEnabled } from '../secure.mjs'

const ACTIVE_VM_KEY = 'active_vm'

export class VmsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
    this._get = db.prepare('SELECT * FROM vms WHERE id = ?')
    this._list = db.prepare('SELECT * FROM vms ORDER BY id')
    this._remove = db.prepare('DELETE FROM vms WHERE id = ?')
    this._upsert = db.prepare(`
      INSERT INTO vms (
        id, name, status, schedulable, email, account_uuid, org_uuid,
        access_token, refresh_token, session_key, oauth_expires_at, oauth_source,
        proxy_id, claude_code_version, timezone, locale,
        vm_json, encrypted, file_mtime_ms, synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, status = excluded.status, schedulable = excluded.schedulable,
        email = excluded.email, account_uuid = excluded.account_uuid, org_uuid = excluded.org_uuid,
        access_token = excluded.access_token, refresh_token = excluded.refresh_token,
        session_key = excluded.session_key, oauth_expires_at = excluded.oauth_expires_at,
        oauth_source = excluded.oauth_source, proxy_id = excluded.proxy_id,
        claude_code_version = excluded.claude_code_version, timezone = excluded.timezone,
        locale = excluded.locale, vm_json = excluded.vm_json, encrypted = excluded.encrypted,
        file_mtime_ms = excluded.file_mtime_ms, synced_at = excluded.synced_at,
        updated_at = excluded.updated_at
    `)
  }

  /** Mirror a parsed vm.json object into the table. */
  upsertFromVmJson(vm, { mtimeMs = null } = {}) {
    if (!vm?.id) return null
    const now = new Date().toISOString()
    const c = vm.claude || {}
    const enc = encryptionEnabled()
    this._upsert.run(
      vm.id,
      vm.name ?? null,
      vm.status ?? null,
      vm.schedulable === false ? 0 : 1,
      c.email ?? null,
      c.account_uuid ?? null,
      c.org_uuid ?? null,
      c.access_token != null ? maybeEncrypt(c.access_token) : null,
      c.refresh_token != null ? maybeEncrypt(c.refresh_token) : null,
      c.session_key != null ? maybeEncrypt(c.session_key) : null,
      c.expires_at != null ? String(c.expires_at) : null,
      c.source ?? null,
      vm.proxy?.id ?? null,
      vm.claude_code_version ?? null,
      vm.timezone ?? null,
      vm.locale ?? null,
      enc ? maybeEncrypt(JSON.stringify(vm)) : JSON.stringify(vm),
      enc ? 1 : 0,
      mtimeMs != null ? Math.floor(mtimeMs) : null,
      now,
      vm.created_at ?? now,
      now,
    )
    return this.get(vm.id)
  }

  /** Returns {row, vm} — row has decrypted credential columns, vm is the parsed vm.json. */
  get(id) {
    return this._decode(this._get.get(id))
  }

  list() {
    return this._list.all().map((r) => this._decode(r))
  }

  ids() {
    return this.db.prepare('SELECT id FROM vms ORDER BY id').all().map((r) => r.id)
  }

  remove(id) {
    return this._remove.run(id).changes > 0
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) c FROM vms').get().c
  }

  getActiveVmId() {
    return this.settings.get(ACTIVE_VM_KEY, null)
  }

  setActiveVmId(id) {
    this.settings.set(ACTIVE_VM_KEY, id)
  }

  _decode(row) {
    if (!row) return null
    let vm = null
    try {
      vm = JSON.parse(maybeDecrypt(row.vm_json))
    } catch {
      vm = null
    }
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      schedulable: !!row.schedulable,
      email: row.email,
      account_uuid: row.account_uuid,
      org_uuid: row.org_uuid,
      access_token: maybeDecrypt(row.access_token),
      refresh_token: maybeDecrypt(row.refresh_token),
      session_key: maybeDecrypt(row.session_key),
      oauth_expires_at: row.oauth_expires_at,
      oauth_source: row.oauth_source,
      proxy_id: row.proxy_id,
      claude_code_version: row.claude_code_version,
      timezone: row.timezone,
      locale: row.locale,
      encrypted: !!row.encrypted,
      file_mtime_ms: row.file_mtime_ms,
      synced_at: row.synced_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      vm,
    }
  }
}
