/**
 * Claude Code OAuth beta sets, aligned with sub2api claude/constants.go.
 *
 * KIN only overwrites VM identity (device / account / stainless).
 * Protocol betas follow sub2api:
 *   official + client beta → passthrough (plus oauth if missing, minus 1M by matrix)
 *   official + empty       → DefaultBetaHeader / HaikuBetaHeader
 *   unofficial / mimic     → FullClaudeCodeMimicryBetas (Haiku: HAIKU_BETA_HEADER), never context-1m
 */
export const BETA_OAUTH = 'oauth-2025-04-20'
export const BETA_CLAUDE_CODE = 'claude-code-20250219'
export const BETA_INTERLEAVED = 'interleaved-thinking-2025-05-14'
export const BETA_FINE_GRAINED_TOOLS = 'fine-grained-tool-streaming-2025-05-14'
export const BETA_PROMPT_CACHING_SCOPE = 'prompt-caching-scope-2026-01-05'
export const BETA_EFFORT = 'effort-2025-11-24'
export const BETA_CONTEXT_MANAGEMENT = 'context-management-2025-06-27'
export const BETA_EXTENDED_CACHE_TTL = 'extended-cache-ttl-2025-04-11'
export const BETA_CONTEXT_1M = 'context-1m-2025-08-07'

export const HAIKU_BETA_HEADER = `${BETA_OAUTH},${BETA_INTERLEAVED}`
export const DEFAULT_BETA_HEADER = `${BETA_CLAUDE_CODE},${BETA_OAUTH},${BETA_INTERLEAVED},${BETA_FINE_GRAINED_TOOLS}`

export function fullClaudeCodeMimicryBetas() {
  return [
    BETA_CLAUDE_CODE,
    BETA_OAUTH,
    BETA_INTERLEAVED,
    BETA_PROMPT_CACHING_SCOPE,
    BETA_EFFORT,
    BETA_CONTEXT_MANAGEMENT,
    BETA_EXTENDED_CACHE_TTL,
  ]
}

export function defaultOfficialBetaHeader(modelId = '') {
  return /haiku/i.test(String(modelId || '')) ? HAIKU_BETA_HEADER : DEFAULT_BETA_HEADER
}

export function joinBetas(tokens = []) {
  return [...tokens].filter(Boolean).join(',')
}

/** sub2api getBetaHeader: official client list must contain oauth-2025-04-20. */
export function ensureOauthBeta(header = '') {
  const parts = String(header || '').split(',').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return header
  if (parts.includes(BETA_OAUTH)) return parts.join(',')
  const idx = parts.indexOf(BETA_CLAUDE_CODE)
  if (idx >= 0) {
    parts.splice(idx + 1, 0, BETA_OAUTH)
    return parts.join(',')
  }
  return [BETA_OAUTH, ...parts].join(',')
}
