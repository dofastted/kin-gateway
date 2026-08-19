import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  openDatabase, closeDatabase, getDb, isDbOpen, getDbPath,
  applyMigrations, resolveDbPath, vacuumInto, withTransaction,
} from '../../src/lib/db/database.mjs'

let tmp

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-db-test-'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.KIN_DB_PATH
})

test('openDatabase creates db, applies migrations, WAL enabled', () => {
  const db = openDatabase({ dataDir: tmp })
  assert.ok(isDbOpen())
  assert.equal(getDbPath(), path.join(tmp, 'kin.db'))
  const mode = db.prepare('PRAGMA journal_mode').get()
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  for (const t of ['settings', 'api_keys', 'accounts', 'account_allocations', 'sticky_sessions', 'proxies', 'vms', 'request_logs', 'request_log_debug', 'backup_records', 'schema_migrations']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
})

test('openDatabase is idempotent singleton; getDb throws when closed', () => {
  const a = openDatabase({ dataDir: tmp })
  const b = openDatabase({ dataDir: path.join(tmp, 'other') })
  assert.equal(a, b)
  closeDatabase()
  assert.throws(() => getDb(), /not opened/)
})

test('migrations are idempotent across reopen', () => {
  openDatabase({ dataDir: tmp })
  closeDatabase()
  const db = openDatabase({ dataDir: tmp })
  const rows = db.prepare('SELECT version FROM schema_migrations').all()
  assert.equal(rows.length, new Set(rows.map((r) => r.version)).size)
})

test('checksum mismatch on applied migration throws', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t1 (a TEXT);')
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  applyMigrations(db, { migrationsDir: migDir })
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t1 (a TEXT, b TEXT);')
  assert.throws(() => applyMigrations(db, { migrationsDir: migDir }), /checksum mismatch/)
  db.close()
})

test('new migration files apply in order and record checksums', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t1 (a TEXT);')
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  let applied = applyMigrations(db, { migrationsDir: migDir })
  assert.deepEqual(applied, ['001_a.sql'])
  fs.writeFileSync(path.join(migDir, '002_b.sql'), 'ALTER TABLE t1 ADD COLUMN b TEXT;')
  applied = applyMigrations(db, { migrationsDir: migDir })
  assert.deepEqual(applied, ['002_b.sql'])
  const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum)))
  db.close()
})

test('failed migration rolls back and is not recorded', () => {
  const migDir = path.join(tmp, 'migs')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(path.join(migDir, '001_bad.sql'), 'CREATE TABLE ok1 (a TEXT); THIS IS NOT SQL;')
  const db = new DatabaseSync(path.join(tmp, 'x.db'))
  assert.throws(() => applyMigrations(db, { migrationsDir: migDir }), /001_bad\.sql failed/)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  assert.ok(!tables.includes('ok1'), 'rollback should drop partial table')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c, 0)
  db.close()
})

test('KIN_DB_PATH env overrides path', () => {
  const custom = path.join(tmp, 'custom', 'my.db')
  process.env.KIN_DB_PATH = custom
  assert.equal(resolveDbPath({ dataDir: tmp }), custom)
  openDatabase({ dataDir: tmp })
  assert.equal(getDbPath(), custom)
  assert.ok(fs.existsSync(custom))
})

test('vacuumInto produces a consistent snapshot', () => {
  const db = openDatabase({ dataDir: tmp })
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run('k1', '"v1"', new Date().toISOString())
  const dest = path.join(tmp, 'backup', 'snap.db')
  vacuumInto(db, dest)
  const snap = new DatabaseSync(dest)
  const row = snap.prepare('SELECT value FROM settings WHERE key = ?').get('k1')
  assert.equal(row.value, '"v1"')
  snap.close()
})

test('withTransaction commits and rolls back', () => {
  const db = openDatabase({ dataDir: tmp })
  withTransaction(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('a', '1')").run()
  })
  assert.ok(db.prepare("SELECT * FROM settings WHERE key='a'").get())
  assert.throws(() => withTransaction(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('b', '2')").run()
    throw new Error('boom')
  }), /boom/)
  assert.equal(db.prepare("SELECT * FROM settings WHERE key='b'").get(), undefined)
})
