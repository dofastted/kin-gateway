/**
 * Model capability matrix + availability control.
 * Persisted in settings key "model_policy"; hot-reloaded on PUT.
 *
 * catalog_mode:
 *   worker_intersect_policy — worker catalog ∩ enabled policy entries (default)
 *   worker_only             — ignore policy enabled flags for listing
 *   policy_only             — only policy models (still must look like Claude ids)
 */

import { SettingsRepo } from "../db/repos/settings-repo.mjs"

function isCatalogModelId(id) {
  const s = String(id || "")
  if (!/^claude-(opus|sonnet|haiku|fable|3)[a-z0-9.-]*$/i.test(s)) return false
  if (s.endsWith("-") || s.endsWith(".")) return false
  if (/\.md$/i.test(s)) return false
  return s.split("-").length >= 3
}

const SETTINGS_KEY = "model_policy"
const CONTEXT_1M = "context-1m-2025-08-07"

const CAP_HAIKU = {
  context_window: 200000,
  supports_1m: false,
  thinking_mode: "enabled_only",
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

const CAP_SONNET45 = {
  context_window: 200000,
  supports_1m: false,
  thinking_mode: "enabled_only",
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: true,
  supports_effort: false,
  supports_context_management: true,
}

const CAP_46 = {
  context_window: 1000000,
  supports_1m: true,
  thinking_mode: "adaptive_or_enabled",
  supports_adaptive: true,
  requires_adaptive: false,
  supports_interleaved: true,
  supports_effort: true,
  supports_context_management: true,
}

const CAP_ADAPTIVE_ONLY = {
  context_window: 1000000,
  supports_1m: true,
  thinking_mode: "adaptive_only",
  supports_adaptive: true,
  requires_adaptive: true,
  supports_interleaved: true,
  supports_effort: true,
  supports_context_management: true,
}

function entry(partial) {
  return {
    enabled: true,
    display_name: partial.display_name || partial.id || "",
    family: partial.family || "other",
    sort: partial.sort ?? 100,
    capabilities: { ...partial.capabilities },
    betas: {
      required: partial.betas?.required || ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
      drop: partial.betas?.drop || [CONTEXT_1M],
      allow_client: partial.betas?.allow_client !== false,
    },
    params: {
      max_tokens_default: partial.params?.max_tokens_default ?? 16384,
      max_tokens_cap: partial.params?.max_tokens_cap ?? 64000,
      thinking_fallback_budget: partial.params?.thinking_fallback_budget ?? 4096,
      on_adaptive: partial.params?.on_adaptive || "passthrough",
      on_enabled: partial.params?.on_enabled || "passthrough",
    },
    aliases: partial.aliases || [],
  }
}

/** Official seed matrix (Aug 2026). Panel "reset" restores this. */
export function seedDefaultPolicy() {
  const models = {}
  const add = (id, cfg) => { models[id] = entry({ id, ...cfg }) }

  add("claude-haiku-4-5-20251001", {
    display_name: "Haiku 4.5",
    family: "haiku",
    sort: 10,
    capabilities: CAP_HAIKU,
    betas: {
      required: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
      drop: [CONTEXT_1M, "effort-2025-11-24", "context-management-2025-06-27"],
    },
    params: {
      max_tokens_default: 8192,
      max_tokens_cap: 64000,
      thinking_fallback_budget: 4096,
      on_adaptive: "convert_to_enabled",
      on_enabled: "passthrough",
    },
    aliases: ["haiku", "claude-haiku-4-5", "claude-3-5-haiku", "claude-3-5-haiku-latest"],
  })

  add("claude-haiku-4-5", {
    display_name: "Haiku 4.5 (alias id)",
    family: "haiku",
    sort: 11,
    capabilities: CAP_HAIKU,
    betas: {
      required: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
      drop: [CONTEXT_1M, "effort-2025-11-24", "context-management-2025-06-27"],
    },
    params: {
      max_tokens_default: 8192,
      max_tokens_cap: 64000,
      thinking_fallback_budget: 4096,
      on_adaptive: "convert_to_enabled",
    },
    aliases: [],
  })

  add("claude-sonnet-4-5-20250929", {
    display_name: "Sonnet 4.5",
    family: "sonnet",
    sort: 15,
    capabilities: CAP_SONNET45,
    params: { on_adaptive: "convert_to_enabled", max_tokens_default: 16384 },
    aliases: ["claude-sonnet-4-5"],
  })

  add("claude-sonnet-4-6", {
    display_name: "Sonnet 4.6",
    family: "sonnet",
    sort: 20,
    capabilities: CAP_46,
    betas: {
      required: ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
      drop: [CONTEXT_1M],
    },
    params: { max_tokens_default: 16384, max_tokens_cap: 64000, on_adaptive: "passthrough" },
    aliases: ["sonnet"],
  })

  add("claude-opus-4-6", {
    display_name: "Opus 4.6",
    family: "opus",
    sort: 25,
    capabilities: CAP_46,
    betas: {
      required: ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
      drop: [CONTEXT_1M],
    },
    params: { max_tokens_default: 32000, max_tokens_cap: 128000, on_adaptive: "passthrough" },
    aliases: [],
  })

  add("claude-opus-4-7", {
    display_name: "Opus 4.7",
    family: "opus",
    sort: 28,
    capabilities: CAP_ADAPTIVE_ONLY,
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: "passthrough",
      on_enabled: "convert_to_adaptive",
    },
  })

  add("claude-opus-4-8", {
    display_name: "Opus 4.8",
    family: "opus",
    sort: 29,
    capabilities: CAP_ADAPTIVE_ONLY,
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: "passthrough",
      on_enabled: "convert_to_adaptive",
    },
  })

  add("claude-sonnet-5", {
    display_name: "Sonnet 5",
    family: "sonnet",
    sort: 30,
    capabilities: CAP_ADAPTIVE_ONLY,
    params: {
      max_tokens_default: 16384,
      max_tokens_cap: 128000,
      on_adaptive: "passthrough",
      on_enabled: "convert_to_adaptive",
    },
    aliases: [],
  })

  add("claude-opus-5", {
    display_name: "Opus 5",
    family: "opus",
    sort: 35,
    capabilities: CAP_ADAPTIVE_ONLY,
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: "passthrough",
      on_enabled: "convert_to_adaptive",
    },
    aliases: ["opus"],
  })

  add("claude-fable-5", {
    display_name: "Fable 5",
    family: "fable",
    sort: 40,
    capabilities: CAP_ADAPTIVE_ONLY,
    params: {
      max_tokens_default: 32000,
      max_tokens_cap: 128000,
      on_adaptive: "passthrough",
      on_enabled: "convert_to_adaptive",
    },
    aliases: ["fable"],
  })

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: "seed",
    defaults: {
      enabled: true,
      max_tokens: 16384,
      thinking_fallback_budget: 4096,
      strip_context_1m: true,
      normalize_thinking: true,
    },
    models,
    aliases: {
      sonnet: "claude-sonnet-4-6",
      opus: "claude-opus-5",
      haiku: "claude-haiku-4-5-20251001",
      "claude-haiku-4-5": "claude-haiku-4-5-20251001",
      "claude-3-5-haiku": "claude-haiku-4-5-20251001",
      "claude-3-5-haiku-latest": "claude-haiku-4-5-20251001",
      fable: "claude-fable-5",
    },
    catalog_mode: "worker_intersect_policy",
  }
}

/** @type {ReturnType<typeof seedDefaultPolicy>} */
let policy = seedDefaultPolicy()
let loaded = false

function deepMergeEntry(base, patch) {
  if (!patch || typeof patch !== "object") return base
  const out = { ...base, ...patch }
  if (patch.capabilities) out.capabilities = { ...base.capabilities, ...patch.capabilities }
  if (patch.betas) {
    out.betas = {
      ...base.betas,
      ...patch.betas,
      required: patch.betas.required ?? base.betas.required,
      drop: patch.betas.drop ?? base.betas.drop,
    }
  }
  if (patch.params) out.params = { ...base.params, ...patch.params }
  if (patch.aliases) out.aliases = patch.aliases
  return out
}

export function normalizePolicy(raw) {
  const seed = seedDefaultPolicy()
  if (!raw || typeof raw !== "object") return seed
  const models = { ...seed.models }
  if (raw.models && typeof raw.models === "object") {
    for (const [id, cfg] of Object.entries(raw.models)) {
      if (!id) continue
      const base = models[id] || entry({
        id,
        display_name: id,
        family: id.includes("haiku") ? "haiku" : id.includes("opus") ? "opus" : id.includes("fable") ? "fable" : "sonnet",
        capabilities: heuristicCapabilities(id),
        params: {},
      })
      models[id] = deepMergeEntry(base, cfg)
    }
  }
  return {
    version: Number(raw.version) || 1,
    updated_at: raw.updated_at || new Date().toISOString(),
    source: raw.source || "panel",
    defaults: { ...seed.defaults, ...(raw.defaults || {}) },
    models,
    aliases: { ...seed.aliases, ...(raw.aliases || {}) },
    catalog_mode: raw.catalog_mode || seed.catalog_mode,
  }
}

function heuristicCapabilities(modelId = "") {
  const m = String(modelId).toLowerCase()
  if (m.includes("haiku") || /claude-3[.-]/.test(m)) return { ...CAP_HAIKU }
  if (/claude-(sonnet|opus)-4-5/.test(m)) return { ...CAP_SONNET45 }
  if (/claude-(opus|sonnet|fable|mythos)-5/.test(m) || /claude-opus-4-[78]/.test(m)) {
    return { ...CAP_ADAPTIVE_ONLY }
  }
  if (/claude-(sonnet|opus)-4-6/.test(m)) return { ...CAP_46 }
  return { ...CAP_46 }
}

export function loadModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    const repo = new SettingsRepo()
    const stored = repo.get(SETTINGS_KEY, null)
    if (stored) {
      policy = normalizePolicy(stored)
      policy.source = policy.source || "settings"
    } else {
      policy = seedDefaultPolicy()
      repo.set(SETTINGS_KEY, policy)
    }
  } catch {
    policy = seedDefaultPolicy()
  }
  loaded = true
  return policy
}

export function getModelPolicy() {
  if (!loaded) loadModelPolicy()
  return policy
}

export function saveModelPolicy(next) {
  policy = normalizePolicy(next)
  policy.updated_at = new Date().toISOString()
  policy.source = "panel"
  try {
    const repo = new SettingsRepo()
    repo.set(SETTINGS_KEY, policy)
  } catch (e) {
    console.warn("[model-policy] persist failed", e?.message || e)
  }
  loaded = true
  return policy
}

export function resetModelPolicy() {
  policy = seedDefaultPolicy()
  try {
    const repo = new SettingsRepo()
    repo.set(SETTINGS_KEY, policy)
  } catch {}
  loaded = true
  return policy
}

export function resolvePolicyModelId(raw = "") {
  if (!loaded) loadModelPolicy()
  const m = String(raw || "").trim()
  if (!m) return null
  const bare = m.split("/").filter(Boolean).pop() || m
  const lower = bare.toLowerCase().replace(/\[[1m]+\]$/i, "")

  const aliasTarget = policy.aliases[lower] || policy.aliases[bare]
  if (aliasTarget && policy.models[aliasTarget]) return aliasTarget

  if (policy.models[bare]) return bare
  if (policy.models[lower]) return lower

  for (const [id, cfg] of Object.entries(policy.models)) {
    if ((cfg.aliases || []).some((a) => String(a).toLowerCase() === lower)) return id
  }

  for (const id of Object.keys(policy.models)) {
    if (id.toLowerCase() === lower) return id
  }

  return bare
}

export function getModelEntry(modelId = "") {
  if (!loaded) loadModelPolicy()
  const key = resolvePolicyModelId(modelId)
  if (key && policy.models[key]) return { id: key, ...policy.models[key] }
  const id = key || String(modelId || "")
  const caps = heuristicCapabilities(id)
  return {
    id,
    enabled: policy.defaults.enabled !== false,
    display_name: id,
    family: "other",
    sort: 999,
    capabilities: caps,
    betas: {
      required: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
      drop: policy.defaults.strip_context_1m !== false ? [CONTEXT_1M] : [],
      allow_client: true,
    },
    params: {
      max_tokens_default: policy.defaults.max_tokens || 16384,
      max_tokens_cap: 64000,
      thinking_fallback_budget: policy.defaults.thinking_fallback_budget || 4096,
      on_adaptive: caps.supports_adaptive ? "passthrough" : "convert_to_enabled",
      on_enabled: caps.requires_adaptive ? "convert_to_adaptive" : "passthrough",
    },
    aliases: [],
    _heuristic: true,
  }
}

export function isModelEnabled(modelId = "") {
  return getModelEntry(modelId).enabled !== false
}

export function getCapabilities(modelId = "") {
  return getModelEntry(modelId).capabilities
}

export function getBetaPolicy(modelId = "") {
  return getModelEntry(modelId).betas
}

export function getModelParams(modelId = "") {
  return getModelEntry(modelId).params
}

export function normalizeThinkingByPolicy(body = {}) {
  if (!loaded) loadModelPolicy()
  if (!body || typeof body !== "object") return body
  if (policy.defaults.normalize_thinking === false) return body
  const thinking = body.thinking
  if (!thinking || typeof thinking !== "object") return body

  const model = body.model || ""
  const entry = getModelEntry(model)
  const type = String(thinking.type || "").toLowerCase()
  const params = entry.params || {}
  const caps = entry.capabilities || {}

  if (type === "adaptive") {
    const action = params.on_adaptive || (caps.supports_adaptive ? "passthrough" : "convert_to_enabled")
    if (action === "strip") {
      delete body.thinking
      return body
    }
    if (action === "convert_to_enabled") {
      const budget = Number(thinking.budget_tokens) > 0
        ? Number(thinking.budget_tokens)
        : (params.thinking_fallback_budget || policy.defaults.thinking_fallback_budget || 4096)
      body.thinking = { type: "enabled", budget_tokens: budget }
      return body
    }
  }

  if (type === "enabled") {
    const action = params.on_enabled || (caps.requires_adaptive ? "convert_to_adaptive" : "passthrough")
    if (action === "strip") {
      delete body.thinking
      return body
    }
    if (action === "convert_to_adaptive") {
      const next = { type: "adaptive" }
      if (thinking.display) next.display = thinking.display
      body.thinking = next
      return body
    }
  }

  return body
}

function stripTokens(header, tokens) {
  const drop = new Set(tokens)
  return String(header || "")
    .split(",")
    .map((s) => s.trim())
    .filter((t) => t && !drop.has(t))
    .join(",")
}

export function applyBetaPolicyToHeader(existingBeta = "", modelId = "", { isOfficial = false } = {}) {
  if (!loaded) loadModelPolicy()
  if (isOfficial) {
    if (policy.defaults.strip_context_1m !== false) {
      return stripTokens(existingBeta, [CONTEXT_1M])
    }
    return existingBeta
  }
  const betas = getBetaPolicy(modelId)
  const drop = new Set(betas.drop || [])
  if (policy.defaults.strip_context_1m !== false) drop.add(CONTEXT_1M)

  let parts = []
  if (betas.allow_client && existingBeta) {
    for (const p of String(existingBeta).split(",")) {
      const t = p.trim()
      if (t && !drop.has(t)) parts.push(t)
    }
  }
  for (const r of betas.required || []) {
    if (!drop.has(r) && !parts.includes(r)) parts.push(r)
  }
  parts = parts.filter((t) => !drop.has(t))
  return parts.join(",")
}

export function filterPublicModelIds(workerIds = []) {
  if (!loaded) loadModelPolicy()
  const mode = policy.catalog_mode || "worker_intersect_policy"
  const ids = [...new Set((workerIds || []).filter(Boolean))]

  if (mode === "worker_only") return ids

  if (mode === "policy_only") {
    return Object.entries(policy.models)
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([id]) => id)
      .filter((id) => isCatalogModelId(id))
  }

  return ids.filter((id) => {
    const key = resolvePolicyModelId(id)
    if (policy.models[key]) return policy.models[key].enabled !== false
    return policy.defaults.enabled !== false
  })
}

export function listPolicyModels() {
  if (!loaded) loadModelPolicy()
  return Object.entries(policy.models)
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100) || a.id.localeCompare(b.id))
}

export function syncWorkerModelsIntoPolicy(workerIds = []) {
  if (!loaded) loadModelPolicy()
  let changed = false
  for (const id of workerIds || []) {
    if (!id || !isCatalogModelId(id)) continue
    if (policy.models[id]) continue
    const caps = heuristicCapabilities(id)
    policy.models[id] = entry({
      id,
      display_name: id,
      family: id.includes("haiku") ? "haiku" : id.includes("opus") ? "opus" : id.includes("fable") ? "fable" : id.includes("sonnet") ? "sonnet" : "other",
      capabilities: caps,
      params: {
        on_adaptive: caps.supports_adaptive ? "passthrough" : "convert_to_enabled",
        on_enabled: caps.requires_adaptive ? "convert_to_adaptive" : "passthrough",
      },
    })
    changed = true
  }
  if (changed) {
    policy.updated_at = new Date().toISOString()
    policy.source = "worker_merge"
    try { new SettingsRepo().set(SETTINGS_KEY, policy) } catch {}
  }
  return policy
}

export function applyMaxTokensCap(body = {}) {
  if (!body || typeof body !== "object") return body
  const params = getModelParams(body.model || "")
  const cap = Number(params.max_tokens_cap)
  if (!cap || !Number.isFinite(cap)) return body
  const mt = Number(body.max_tokens)
  if (Number.isFinite(mt) && mt > cap) body.max_tokens = cap
  return body
}
