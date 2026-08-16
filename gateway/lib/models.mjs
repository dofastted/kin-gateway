/**
 * Official Claude models — fetch from Anthropic /v1/models (OAuth).
 * No third-party aliases. Cache short-lived in memory.
 */

const MODELS_URL = 'https://api.anthropic.com/v1/models'
const CACHE_TTL_MS = 5 * 60 * 1000

let cache = { at: 0, data: null }

/** Static fallback if upstream models list fails */
export const OFFICIAL_CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet-20250219',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
]

/**
 * Fetch models from official Anthropic API using VM OAuth token.
 * @returns {{ object: 'list', data: Array, source: string, fetched_at?: string }}
 */
export async function fetchOfficialModels(accessToken, { force = false, timeoutMs = 15000 } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, source: 'cache', cached_at: new Date(cache.at).toISOString() }
  }

  if (!accessToken) {
    return { object: 'list', data: listOfficialModels(), source: 'fallback_static' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(MODELS_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
        'user-agent': 'claude-cli/2.1.233 (external, sdk-cli)',
        'x-app': 'cli',
      },
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }

    if (!res.ok || !body?.data) {
      return {
        object: 'list',
        data: listOfficialModels(),
        source: 'fallback_static',
        upstream_status: res.status,
        upstream_error: body?.error || text.slice(0, 200),
      }
    }

    // Only Claude models — never expose non-claude
    const data = (body.data || [])
      .filter((m) => m && String(m.id || '').startsWith('claude-'))
      .map((m) => ({
        id: m.id,
        object: 'model',
        type: m.type || 'model',
        display_name: m.display_name || m.id,
        created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : undefined,
        created_at: m.created_at || null,
        owned_by: 'anthropic',
        max_input_tokens: m.max_input_tokens,
        max_tokens: m.max_tokens,
        capabilities: m.capabilities || undefined,
      }))

    const result = {
      object: 'list',
      data,
      source: 'anthropic_api',
      fetched_at: new Date().toISOString(),
    }
    cache = { at: Date.now(), data: result }
    return result
  } catch (e) {
    return {
      object: 'list',
      data: listOfficialModels(),
      source: 'fallback_static',
      error: String(e.message || e),
    }
  } finally {
    clearTimeout(timer)
  }
}

export function listOfficialModels() {
  return OFFICIAL_CLAUDE_MODELS.map((id) => ({
    id,
    object: 'model',
    owned_by: 'anthropic',
  }))
}

/**
 * Validate model id — official Claude names only, no aliases.
 * If live list is cached, prefer membership; always allow claude-* prefix.
 */
export function validateOfficialModel(model) {
  const m = String(model || '').trim()
  if (!m) {
    return {
      ok: false,
      error: {
        message:
          'model is required. Only official Claude model names are supported (e.g. claude-haiku-4-5-20251001).',
        type: 'invalid_request_error',
        code: 'model_required',
      },
    }
  }

  if (/^(gpt-|o1|o3|o4|text-|davinci|gemini|deepseek|mistral|grok)/i.test(m)) {
    return {
      ok: false,
      error: {
        message: `model '${m}' is not supported. Only official Claude model names are accepted. Aliases are disabled.`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
        param: 'model',
      },
    }
  }

  if (/^claude-/i.test(m)) {
    return { ok: true, model: m }
  }

  // If we have a live cache, check exact id
  if (cache.data?.data?.some((x) => x.id === m)) {
    return { ok: true, model: m }
  }

  return {
    ok: false,
    error: {
      message: `model '${m}' is not an official Claude model name. Request rejected; no upstream call.`,
      type: 'invalid_request_error',
      code: 'model_not_supported',
      param: 'model',
    },
  }
}

export function clearModelsCache() {
  cache = { at: 0, data: null }
}
