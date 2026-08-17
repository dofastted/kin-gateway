/**
 * Models the VM official Claude Code actually recognizes.
 * Harvested from the installed CLI binary — never a gateway Anthropic models HTTP call.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const CLI_BIN_CANDIDATES = [
  process.env.CLAUDE_CLI_PATH,
  '/usr/bin/claude',
  '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
].filter(Boolean)

const FAMILY_ALIASES = new Map([
  ['sonnet', 'sonnet'],
  ['opus', 'opus'],
  ['haiku', 'haiku'],
  ['fable', 'fable'],
  ['sonnet[1m]', 'sonnet'],
  ['opus[1m]', 'opus'],
  ['haiku[1m]', 'haiku'],
  ['fable[1m]', 'fable'],
])

const ID_RE = /"claude-(?:opus|sonnet|haiku|fable|3)[a-zA-Z0-9._-]{2,48}"/g

/** @type {{ at: number, key: string, ids: string[], aliases: string[], version: string|null, bin: string|null }} */
let cache = { at: 0, key: '', ids: [], aliases: [], version: null, bin: null }

/** @deprecated kept so old imports do not crash; no longer the source of truth */
export const OFFICIAL_CLAUDE_MODELS = []

export function resolveCliBin(explicit) {
  if (explicit && fs.existsSync(explicit)) {
    try { return fs.realpathSync(explicit) } catch { return explicit }
  }
  for (const p of CLI_BIN_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return fs.realpathSync(p)
    } catch {
      if (p && fs.existsSync(p)) return p
    }
  }
  return null
}

export function isCatalogModelId(id) {
  const s = String(id || '')
  if (!/^claude-(opus|sonnet|haiku|fable|3)[a-z0-9.-]*$/i.test(s)) return false
  if (s.endsWith('-') || s.endsWith('.')) return false
  if (/\.md$/i.test(s)) return false
  return s.split('-').length >= 3
}

export function extractQuotedClaudeIds(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '')
  const ids = new Set()
  ID_RE.lastIndex = 0
  let m
  while ((m = ID_RE.exec(text))) {
    const id = m[0].slice(1, -1)
    if (isCatalogModelId(id)) ids.add(id)
  }
  return [...ids]
}

function readBinaryQuotedIds(binPath) {
  const fd = fs.openSync(binPath, 'r')
  const chunk = Buffer.alloc(1024 * 1024)
  const ids = new Set()
  let carry = ''
  try {
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (!n) break
      const text = carry + chunk.toString('latin1', 0, n)
      carry = text.slice(-80)
      ID_RE.lastIndex = 0
      let m
      while ((m = ID_RE.exec(text))) {
        const id = m[0].slice(1, -1)
        if (isCatalogModelId(id)) ids.add(id)
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return [...ids]
}

function modelRank(id) {
  const body = String(id).replace(/^claude-(opus|sonnet|haiku|fable|3)-/i, '')
  return body.split(/[-.]/).map((p) => {
    if (/^\d{8}$/.test(p)) return Number(p)
    if (/^\d+$/.test(p)) return Number(p)
    return -1
  })
}

function cmpRank(a, b) {
  const ra = modelRank(a)
  const rb = modelRank(b)
  const n = Math.max(ra.length, rb.length)
  for (let i = 0; i < n; i++) {
    const da = ra[i] ?? -1
    const db = rb[i] ?? -1
    if (db !== da) return db - da
  }
  return a.length - b.length
}

export function latestIdForFamily(family, ids) {
  const fam = String(family || '').toLowerCase()
  const preferred = (ids || []).filter((id) => {
    if (!id.toLowerCase().startsWith(`claude-${fam}-`)) return false
    if (/-fast$/i.test(id) || /-latest$/i.test(id) || /-v\d+$/i.test(id)) return false
    return true
  })
  preferred.sort(cmpRank)
  return preferred[0] || null
}

export function resolveCliModel(raw, ids = cache.ids) {
  const m = String(raw || '').trim()
  if (!m) return { ok: false, reason: 'empty' }
  const bare = m.split('/').filter(Boolean).pop() || m
  const lower = bare.toLowerCase()
  const want1m = /\[[1m]+\]$/i.test(bare)
  const aliasKey = lower
  if (FAMILY_ALIASES.has(aliasKey) || FAMILY_ALIASES.has(lower.replace(/\[1m\]$/i, '') + (want1m ? '[1m]' : ''))) {
    const fam = FAMILY_ALIASES.get(aliasKey) || FAMILY_ALIASES.get(lower.replace(/\[1m\]$/i, ''))
    const latest = latestIdForFamily(fam, ids)
    if (latest) return { ok: true, model: want1m ? `${latest}[1m]` : latest, alias: fam }
  }
  const id = /^claude-/i.test(bare) ? bare : m
  if (ids.length && ids.some((x) => x.toLowerCase() === id.toLowerCase())) {
    return { ok: true, model: id }
  }
  if (!ids.length && /^claude-/i.test(id)) {
    return { ok: true, model: id, unverified: true }
  }
  return { ok: false, model: id, reason: 'not_in_cli_catalog' }
}

function binCacheKey(bin) {
  try {
    const st = fs.statSync(bin)
    return `${bin}:${st.size}:${Math.floor(st.mtimeMs)}`
  } catch {
    return bin || 'missing'
  }
}

function persistPath() {
  return process.env.KIN_CLI_MODELS_CACHE
    || path.join(process.cwd(), 'data', 'cli-models.json')
}

function readPersisted(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath(), 'utf8'))
    if (raw?.key === key && Array.isArray(raw.ids) && raw.ids.length) return raw
  } catch {}
  return null
}

function writePersisted(entry) {
  try {
    const p = persistPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(entry, null, 2))
  } catch {}
}

function readCliVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        PATH: process.env.PATH || '/usr/bin',
        CI: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
        HOME: process.env.HOME || '/tmp',
      },
    })
    const text = `${r.stdout || ''} ${r.stderr || ''}`.trim()
    const m = text.match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : (text.slice(0, 40) || null)
  } catch {
    return null
  }
}

export function harvestCliModelCatalog({ cliBin = null, force = false } = {}) {
  if (!force && cache.key === 'test' && cache.ids.length) return cache
  const bin = resolveCliBin(cliBin)
  const key = binCacheKey(bin)
  if (!force && cache.ids.length && cache.key === key) return cache
  if (!bin) {
    cache = { at: Date.now(), key, ids: [], aliases: [...FAMILY_ALIASES.keys()], version: null, bin: null }
    return cache
  }
  if (!force) {
    const disk = readPersisted(key)
    if (disk) {
      cache = { at: Date.now(), key, ids: disk.ids, aliases: disk.aliases || [...FAMILY_ALIASES.keys()], version: disk.version || null, bin }
      return cache
    }
  }
  const ids = readBinaryQuotedIds(bin).sort(cmpRank)
  const version = readCliVersion(bin)
  cache = {
    at: Date.now(),
    key,
    ids,
    aliases: [...FAMILY_ALIASES.keys()],
    version,
    bin,
  }
  writePersisted({ key, ids, aliases: cache.aliases, version, harvested_at: new Date().toISOString() })
  return cache
}

/** Test helper — inject a catalog without touching the CLI binary. */
export function setCliModelCatalogForTest(ids, { version = 'test', bin = 'test' } = {}) {
  cache = {
    at: Date.now(),
    key: 'test',
    ids: [...new Set(ids || [])],
    aliases: [...FAMILY_ALIASES.keys()],
    version,
    bin,
  }
  return cache
}

export function clearModelsCache() {
  cache = { at: 0, key: '', ids: [], aliases: [], version: null, bin: null }
}

export function listOfficialModels() {
  if (!cache.ids.length) harvestCliModelCatalog()
  return (cache.ids || []).map((id) => ({
    id,
    object: 'model',
    type: 'model',
    display_name: id,
    owned_by: 'anthropic',
    source: 'claude_cli_catalog',
  }))
}

/**
 * Compat name. Tokens are ignored — models come from the VM CLI, not OAuth HTTP.
 */
export async function fetchOfficialModels(_accessToken, { force = false } = {}) {
  const harvested = harvestCliModelCatalog({ force })
  const data = listOfficialModels()
  return {
    object: 'list',
    data,
    source: harvested.ids.length ? 'claude_cli_catalog' : 'cli_catalog_unavailable',
    fetched_at: new Date().toISOString(),
    total: data.length,
    cli_version: harvested.version,
    cli_bin: harvested.bin,
    aliases: harvested.aliases,
    note: harvested.ids.length
      ? 'Models recognized by the VM official Claude Code binary'
      : 'CLI binary not readable; catalog empty',
  }
}

/**
 * Only names the VM Claude Code catalog knows.
 * Provider prefixes (anthropic/…, openrouter/anthropic/…) are stripped first.
 * Family aliases (sonnet/opus/haiku/fable) resolve to the latest CLI id.
 */
export function validateOfficialModel(model) {
  const m = String(model || '').trim()
  if (!m) {
    return {
      ok: false,
      error: {
        message: 'model is required. Use a model this VM Claude Code recognizes.',
        type: 'invalid_request_error',
        code: 'model_required',
      },
    }
  }

  const bare = m.split('/').filter(Boolean).pop() || m
  const id = /^claude-/i.test(bare) ? bare : bare

  if (/^(gpt-|o1|o3|o4|text-|davinci|gemini|deepseek|mistral|grok)/i.test(id)) {
    return {
      ok: false,
      error: {
        message: `model '${m}' is not supported. Only models recognized by VM Claude Code are accepted.`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
        param: 'model',
      },
    }
  }

  if (!cache.ids.length && cache.key !== 'test') harvestCliModelCatalog()
  const resolved = resolveCliModel(m, cache.ids)
  if (resolved.ok) {
    return { ok: true, model: resolved.model, alias: resolved.alias || null, unverified: !!resolved.unverified }
  }

  return {
    ok: false,
    error: {
      message: `model '${m}' is not recognized by this VM Claude Code. Request rejected; no hop.`,
      type: 'invalid_request_error',
      code: 'model_not_supported',
      param: 'model',
    },
  }
}
