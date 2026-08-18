/**
 * SQLite database layer — sub2api data-layer inspired, on node:sqlite.
 *
 * - Single-process gateway → embedded SQLite (WAL) instead of sub2api's
 *   PostgreSQL+Redis. Same patterns: versioned SQL migrations with SHA-256
 *   checksum verification (sub2api migrations_runner), repository modules,
 *   settings table, backup records.
 * - Zero new dependencies: uses the built-in `node:sqlite` DatabaseSync.
 *
 * Env:
 *   KIN_DB_PATH — override db file path (default <dataDir>/kin.db)
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

let _db = null
let _dbPath = null

export function resolveDbPath({ dataDir, dbPath } = {}) {
  if (dbPath) return dbPath
  if (process.env.KIN_DB_PATH) return process.env.KIN_DB_PATH
  const dir = dataDir || path.join(process.cwd(), 'data')
  return path.join(dir, 'kin.db')
}

/**
 * Open (or return the already-open) database, apply PRAGMAs + migrations.
 * @returns {DatabaseSync}
 */
export function openDatabase({ dataDir, dbPath, migrationsDir } = {}) {
  if (_db) return _db
  const file = resolveDbPath({ dataDir, dbPath })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try { fs.chmodSync(file, 0o600) } catch {}
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrations(db, { migrationsDir })
  _db = db
  _dbPath = file
  return _db
}

/** Current db instance (throws when not opened). */
export function getDb() {
  if (!_db) throw new Error('database not opened — call openDatabase() first')
  return _db
}

export function isDbOpen() {
  return !!_db
}

export function getDbPath() {
  return _dbPath
}

export function closeDatabase() {
  if (_db) {
    try { _db.close() } catch {}
  }
  _db = null
  _dbPath = null
}

/**
 * Versioned SQL migrations with checksum verification (sub2api-style).
 * Files: migrations/NNN_name.sql, applied in filename order inside a
 * transaction each. `schema_migrations` records version+checksum; a
 * checksum mismatch on an already-applied migration is a hard error.
 */
export function applyMigrations(db, { migrationsDir } = {}) {
  const dir = migrationsDir || MIGRATIONS_DIR
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT,
    checksum TEXT,
    applied_at TEXT
  )`)

  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
    : []

  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations').all()
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]))
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  )

  const results = []
  for (const file of files) {
    const version = file.split('_')[0]
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    const checksum = crypto.createHash('sha256').update(sql).digest('hex')
    if (applied.has(version)) {
      if (applied.get(version) !== checksum) {
        throw new Error(
          `migration checksum mismatch for ${file}: applied=${applied.get(version)} current=${checksum}`,
        )
      }
      continue
    }
    db.exec('BEGIN')
    try {
      db.exec(sql)
      insert.run(version, file, checksum, new Date().toISOString())
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch {}
      throw new Error(`migration ${file} failed: ${e.message}`)
    }
    results.push(file)
  }
  return results
}

/** Run fn inside a transaction (nested calls just run inline). */
export function withTransaction(db, fn) {
  let inTx = false
  try {
    db.exec('BEGIN')
    inTx = true
  } catch {
    // already inside a transaction — run inline
    return fn()
  }
  try {
    const out = fn()
    db.exec('COMMIT')
    inTx = false
    return out
  } catch (e) {
    if (inTx) { try { db.exec('ROLLBACK') } catch {} }
    throw e
  }
}

/**
 * Online-consistent snapshot of the live database (WAL-safe).
 * @returns {string} destination path
 */
export function vacuumInto(db, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  try { fs.rmSync(destPath, { force: true }) } catch {}
  const esc = String(destPath).replace(/'/g, "''")
  db.exec(`VACUUM INTO '${esc}'`)
  try { fs.chmodSync(destPath, 0o600) } catch {}
  return destPath
}
