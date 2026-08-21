/**
 * Official Claude model catalog.
 * Fed by the Go slot workers (`/internal/v1/models` via the slot SOCKS5).
 * The gateway never calls Anthropic directly and never reads a CLI binary.
 */

import { isModelEnabled, filterPublicModelIds, getModelEntry, getModelPolicy, loadModelPolicy } from './model-policy.mjs'
import { hasClaudeCode1mSuffix, stripClaudeCode1mSuffix } from './context-1m.mjs'

const FAMILY_ALIASES = new Map([
  ['sonnet', 'sonnet'],
  ['opus', 'opus'],
  ['haiku', 'haiku'],
  ['fable', 'fable'],
])

/** @type {{ at: number, ids: string[], aliases: string[], source: string|null }} */
let cache = { at: 0, ids: [], aliases: [], source: null }

/** Local catalog so GET /v1/models is never empty when Anthropic OAuth /v1/models is unusable. */
export const SEED_MODEL_IDS = [
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
]

export function seedModelCatalog() {
  if (cache.ids.length) return cache
  return setModelCatalog(SEED_MODEL_IDS, { source: 'go-slot-worker-seed' })
}

export function isCatalogModelId(id) {
  const s = String(id || '')
  if (!/^claude-(opus|sonnet|haiku|fable|3)[a-z0-9.-]*$/i.test(s)) return false
  if (s.endsWith('-') || s.endsWith('.')) return false
  if (/\.md$/i.test(s)) return false
  return s.split('-').length >= 3
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

/** Anthropic calling alias: claude-haiku-4-5 → claude-haiku-4-5-20251001 */
export function undatedAliasOf(id) {
  return String(id || '').replace(/-\d{8}$/, '')
}

export function latestIdForUndatedAlias(raw, ids) {
  const lower = String(raw || '').toLowerCase()
  if (!lower) return null
  const hits = (ids || []).filter((id) => undatedAliasOf(id).toLowerCase() === lower)
  hits.sort(cmpRank)
  return hits[0] || null
}

function resolvePolicyAliasToCatalog(raw, ids) {
  try {
    loadModelPolicy()
    const policy = getModelPolicy()
    const lower = String(raw || '').toLowerCase()
    const candidates = []
    const top = policy.aliases?.[lower]
    if (top) candidates.push(String(top))
    for (const [id, cfg] of Object.entries(policy.models || {})) {
      if (id.toLowerCase() === lower) candidates.push(id)
      if ((cfg.aliases || []).some((a) => String(a).toLowerCase() === lower)) candidates.push(id)
    }
    for (const c of candidates) {
      const exact = (ids || []).find((x) => x.toLowerCase() === String(c).toLowerCase())
      if (exact) return exact
      const dated = latestIdForUndatedAlias(c, ids)
      if (dated) return dated
    }
  } catch {}
  return null
}

export function resolveCatalogModel(raw, ids = cache.ids) {
  const m = String(raw || '').trim()
  if (!m) return { ok: false, reason: 'empty' }
  const popped = m.split('/').filter(Boolean).pop() || m
  const want1m = hasClaudeCode1mSuffix(popped)
  const bare = stripClaudeCode1mSuffix(popped)
  const lower = bare.toLowerCase()
  if (FAMILY_ALIASES.has(lower)) {
    const fam = FAMILY_ALIASES.get(lower)
    const latest = latestIdForFamily(fam, ids)
    if (latest) return { ok: true, model: latest, alias: fam, want1m }
  }
  const id = /^claude-/i.test(bare) ? bare : stripClaudeCode1mSuffix(m)
  if (ids.length && ids.some((x) => x.toLowerCase() === id.toLowerCase())) {
    return { ok: true, model: id, want1m }
  }
  const dated = latestIdForUndatedAlias(id, ids)
  if (dated) return { ok: true, model: dated, alias: id, want1m }
  const viaPolicy = resolvePolicyAliasToCatalog(id, ids)
  if (viaPolicy) return { ok: true, model: viaPolicy, alias: id, want1m }
  // Fail closed: empty catalog or unknown id → reject. Never passthrough unverified claude-*.
  return { ok: false, model: id, want1m, reason: ids.length ? 'not_in_catalog' : 'catalog_unavailable' }
}

/**
 * Replace the cached catalog. Production feed: Go slot worker models responses.
 * Tests inject a catalog with the same call.
 */
export function setModelCatalog(ids, { source = 'go-slot-worker' } = {}) {
  cache = {
    at: Date.now(),
    ids: [...new Set((ids || []).filter((id) => isCatalogModelId(id)))],
    aliases: [...FAMILY_ALIASES.keys()],
    source,
  }
  return cache
}

/** Merge worker model list objects ({ data: [{id}] }) into the catalog. */
export function ingestWorkerModels(list) {
  const ids = (Array.isArray(list?.data) ? list.data : [])
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter(Boolean)
  if (!ids.length) return cache
  return setModelCatalog([...new Set([...cache.ids, ...ids])], { source: 'go-slot-worker' })
}

export function getCatalogIds() {
  return [...(cache.ids || [])]
}

export function clearModelsCache() {
  cache = { at: 0, ids: [], aliases: [], source: null }
}

export function listOfficialModels() {
  try { loadModelPolicy() } catch {}
  const ids = filterPublicModelIds(cache.ids || [])
  return ids.map((id) => {
    let display = id
    let extra = {}
    try {
      const e = getModelEntry(id)
      display = e.display_name || id
      extra = {
        family: e.family,
        enabled: e.enabled !== false,
        capabilities: e.capabilities,
      }
    } catch {}
    return {
      id,
      object: 'model',
      type: 'model',
      display_name: display,
      owned_by: 'anthropic',
      source: cache.source || 'worker_catalog',
      ...extra,
    }
  })
}

/**
 * Only names the worker catalog knows.
 * Provider prefixes (anthropic/…, openrouter/anthropic/…) are stripped first.
 * Family aliases (sonnet/opus/haiku/fable) resolve to the latest catalog id.
 */
export function validateOfficialModel(model) {
  const m = String(model || '').trim()
  if (!m) {
    return {
      ok: false,
      error: {
        message: 'model is required. Use a model the slot workers recognize.',
        type: 'invalid_request_error',
        code: 'model_required',
      },
    }
  }

  const bare = stripClaudeCode1mSuffix(m.split('/').filter(Boolean).pop() || m)
  const id = bare

  if (/^(gpt-|o1|o3|o4|text-|davinci|gemini|deepseek|mistral|grok)/i.test(id)) {
    return {
      ok: false,
      error: {
        message: `model '${m}' is not supported. Only official Claude models are accepted.`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
        param: 'model',
      },
    }
  }

  // Go slot workers own the live model catalog. Request validation remains
  // fail-closed for non-Claude providers while allowing well-formed official
  // Claude IDs when the asynchronous worker catalog is not yet cached.
  const resolved = resolveCatalogModel(m, cache.ids)
  if (resolved.ok) {
    try {
      if (!isModelEnabled(resolved.model)) {
        return {
          ok: false,
          error: {
            message: `model '${m}' is disabled by gateway model policy.`,
            type: 'invalid_request_error',
            code: 'model_disabled',
            param: 'model',
          },
        }
      }
    } catch {}
    return { ok: true, model: resolved.model, alias: resolved.alias || null, want1m: !!resolved.want1m }
  }
  if (!cache.ids.length && isCatalogModelId(id)) {
    return { ok: true, model: id, alias: null, want1m: hasClaudeCode1mSuffix(m), source: 'worker_catalog_pending' }
  }

  return {
    ok: false,
    error: {
      message: `model '${m}' is not recognized by the slot worker catalog. Request rejected; no hop.`,
      type: 'invalid_request_error',
      code: 'model_not_supported',
      param: 'model',
    },
  }
}
