/**
 * Official Claude model catalog.
 * Fed by the Go slot workers (`/internal/v1/models` via the slot SOCKS5).
 * The gateway never calls Anthropic directly and never reads a CLI binary.
 */

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

/** @type {{ at: number, ids: string[], aliases: string[], source: string|null }} */
let cache = { at: 0, ids: [], aliases: [], source: null }

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

export function resolveCatalogModel(raw, ids = cache.ids) {
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
  // Fail closed: empty catalog or unknown id → reject. Never passthrough unverified claude-*.
  return { ok: false, model: id, reason: ids.length ? 'not_in_catalog' : 'catalog_unavailable' }
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

export function clearModelsCache() {
  cache = { at: 0, ids: [], aliases: [], source: null }
}

export function listOfficialModels() {
  return (cache.ids || []).map((id) => ({
    id,
    object: 'model',
    type: 'model',
    display_name: id,
    owned_by: 'anthropic',
    source: cache.source || 'worker_catalog',
  }))
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

  const bare = m.split('/').filter(Boolean).pop() || m
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
    return { ok: true, model: resolved.model, alias: resolved.alias || null }
  }
  if (!cache.ids.length && isCatalogModelId(id)) {
    return { ok: true, model: id, alias: null, source: 'worker_catalog_pending' }
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
