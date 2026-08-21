import crypto from 'node:crypto'
import { isAnthropicServerTool } from './web-search.mjs'
import { normalizeThinkingForModel } from './thinking.mjs'
import { applyMaxTokensCap, getCapabilities } from './model-policy.mjs'
import { ensureOutputConfigSchema, rectifyUnofficialRequest } from './request-rectifier.mjs'

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

function clone(value) {
  return structuredClone(value)
}

function emptyText(block) {
  return block?.type === 'text' && String(block.text || '').length === 0
}

function cleanContent(content) {
  if (!Array.isArray(content)) return content
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return block
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return { ...block, content: cleanContent(block.content) }
      }
      return block
    })
    .filter((block) => !emptyText(block))
}

function cacheControlLocations(body) {
  const locations = []
  const add = (block, section, index) => {
    if (block?.cache_control) locations.push({ block, section, index })
  }
  for (const [index, tool] of (body.tools || []).entries()) add(tool, 'tools', index)
  for (const [index, block] of (Array.isArray(body.system) ? body.system : []).entries()) add(block, 'system', index)
  for (const [messageIndex, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (block?.cache_control) locations.push({
        block,
        section: 'messages',
        index: messageIndex,
        blockIndex,
      })
    }
  }
  return locations
}

function normalizeCacheTTL(body) {
  let sawFiveMinute = false
  for (const location of cacheControlLocations(body)) {
    const control = location.block.cache_control
    const ttl = String(control?.ttl || '').toLowerCase()
    if (ttl === '5m') sawFiveMinute = true
    if (sawFiveMinute && ttl === '1h') {
      location.block.cache_control = { ...control, ttl: '5m' }
    }
  }
}

function enforceCacheLimit(body, maximum = 4) {
  const locations = cacheControlLocations(body)
  if (locations.length <= maximum) return
  // Preserve the latest evaluation breakpoints. Remove earlier request-owned
  // markers without deleting the content itself.
  for (const location of locations.slice(0, locations.length - maximum)) {
    delete location.block.cache_control
  }
}

const CLEAR_THINKING_EDIT = Object.freeze({
  type: 'clear_thinking_20251015',
  keep: 'all',
})

const DUMMY_THINKING_SIGNATURES = new Set([
  '',
  'skip_thought_signature_validator',
])

export function hasUsableThinkingSignature(signature) {
  const value = String(signature || '').trim()
  // Truncated SSE signatures look present but fail Anthropic checksum (sub2api pre-filter).
  if (!value || value.length < 24) return false
  return !DUMMY_THINKING_SIGNATURES.has(value)
}

function thinkingModeEnabled(body) {
  const type = String(body?.thinking?.type || '').toLowerCase()
  return type === 'enabled' || type === 'adaptive'
}

/**
 * Anthropic: thinking enabled/adaptive only accepts temperature=1.
 * top_p / top_k are also rejected. Real Claude Code sends temperature: 1.
 */
export function alignSamplingWithThinking(body = {}) {
  if (!thinkingModeEnabled(body)) return body
  const out = body
  if (out.temperature !== 1) out.temperature = 1
  if (Object.prototype.hasOwnProperty.call(out, 'top_p')) delete out.top_p
  if (Object.prototype.hasOwnProperty.call(out, 'top_k')) delete out.top_k
  return out
}

/** Drop history thinking blocks Anthropic would reject (empty / unsigned / dummy). */
export function stripInvalidThinkingBlocks(body = {}) {
  if (!Array.isArray(body.messages)) return body
  const keepSigned = thinkingModeEnabled(body)
  let changed = false
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message
    const content = []
    let filteredThis = false
    for (const block of message.content) {
      const type = block?.type
      if (type === 'thinking' || type === 'redacted_thinking') {
        if (keepSigned && message.role === 'assistant') {
          if (type === 'thinking' && !String(block.thinking || '').trim()) {
            changed = true
            filteredThis = true
            continue
          }
          if (hasUsableThinkingSignature(block.signature)) {
            content.push(block)
            continue
          }
        }
        changed = true
        filteredThis = true
        continue
      }
      content.push(block)
    }
    return filteredThis ? { ...message, content } : message
  })
  if (!changed) return body
  return { ...body, messages }
}

export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'

export function modelSupportsContextManagement(modelId = '') {
  const caps = getCapabilities(modelId)
  if (caps?.supports_context_management === false) return false
  if (/haiku/i.test(String(modelId || ''))) return false
  return true
}

/** sub2api OAuth: real CLI attaches this when thinking is enabled/adaptive. */
export function ensureClearThinkingContextManagement(body = {}) {
  if (!thinkingModeEnabled(body)) return body
  if (!modelSupportsContextManagement(body.model)) {
    if (body.context_management == null) return body
    const out = { ...body }
    delete out.context_management
    return out
  }
  if (body.context_management != null) return body
  return {
    ...body,
    context_management: { edits: [{ ...CLEAR_THINKING_EDIT }] },
  }
}

export function anthropicBetaTokensContains(header, token) {
  if (!header || !token) return false
  return String(header)
    .split(',')
    .map((part) => part.trim())
    .includes(token)
}

/**
 * sub2api sanitizeAnthropicBodyForBetaTokens: keep context_management only when
 * the final anthropic-beta header carries context-management-2025-06-27.
 * Call after headers are resolved, before the Go worker envelope (CCH).
 */
export function sanitizeAnthropicBodyForBetaTokens(body = {}, anthropicBetaHeader = '') {
  if (!body || typeof body !== 'object') return body
  if (!Object.prototype.hasOwnProperty.call(body, 'context_management')) return body
  if (anthropicBetaTokensContains(anthropicBetaHeader, CONTEXT_MANAGEMENT_BETA)) return body
  const out = { ...body }
  delete out.context_management
  return out
}

/** sub2api normalizeClaudeOAuthRequestBody defaults (temperature / empty tools). */
export function ensureClaudeOAuthBodyDefaults(body = {}) {
  const out = body && typeof body === 'object' ? body : {}
  if (out.temperature == null) out.temperature = 1
  if (!Array.isArray(out.tools)) out.tools = []
  if (out.tools.length === 0 && out.tool_choice) delete out.tool_choice
  return out
}

export function prepareAnthropicRequest(body = {}, {
  cacheControlLimit = 4,
  unofficial = false,
} = {}) {
  let out = clone(body)
  // Model-aware thinking normalize (adaptive ↔ enabled) before other policy
  normalizeThinkingForModel(out)
  applyMaxTokensCap(out)
  if (unofficial) out = rectifyUnofficialRequest(out)
  else out = ensureOutputConfigSchema(out)
  if (Array.isArray(out.system)) {
    out.system = cleanContent(out.system)
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => ({
      ...message,
      content: cleanContent(message?.content),
    }))
  }
  const stripped = stripInvalidThinkingBlocks(out)
  if (stripped.messages) out.messages = stripped.messages
  out = ensureClearThinkingContextManagement(out)
  out = alignSamplingWithThinking(out)
  out = ensureClaudeOAuthBodyDefaults(out)
  normalizeCacheTTL(out)
  enforceCacheLimit(out, cacheControlLimit)
  return out
}

function safeToolName(name, used) {
  const original = String(name || '')
  if (TOOL_NAME.test(original) && !used.has(original)) {
    used.add(original)
    return original
  }
  const digest = crypto.createHash('sha256').update(original).digest('hex').slice(0, 16)
  let candidate = `kin_tool_${digest}`
  let suffix = 1
  while (used.has(candidate)) {
    candidate = `kin_tool_${digest}_${suffix++}`
  }
  used.add(candidate)
  return candidate
}

export function rewriteToolNames(body = {}, { enabled = true } = {}) {
  if (!enabled || !Array.isArray(body.tools) || body.tools.length === 0) {
    return { body, reverse: {} }
  }
  const out = clone(body)
  const used = new Set()
  const forward = {}
  const reverse = {}
  out.tools = out.tools.map((tool) => {
    if (isAnthropicServerTool(tool)) return tool
    const original = String(tool?.name || '')
    const rewritten = safeToolName(original, used)
    forward[original] = rewritten
    reverse[rewritten] = original
    return { ...tool, name: rewritten }
  })
  if (out.tool_choice?.name && forward[out.tool_choice.name]) {
    out.tool_choice = { ...out.tool_choice, name: forward[out.tool_choice.name] }
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => {
          if (block?.type === 'tool_use' && forward[block.name]) {
            return { ...block, name: forward[block.name] }
          }
          return block
        }),
      }
    })
  }
  return { body: out, reverse }
}

export function restoreToolNames(response, reverse = {}) {
  if (!response || typeof response !== 'object' || Object.keys(reverse).length === 0) return response
  const out = clone(response)
  const restoreBlocks = (content) => {
    if (!Array.isArray(content)) return content
    return content.map((block) => (
      block?.type === 'tool_use' && reverse[block.name]
        ? { ...block, name: reverse[block.name] }
        : block
    ))
  }
  out.content = restoreBlocks(out.content)
  if (out.message) out.message.content = restoreBlocks(out.message.content)
  return out
}

export function restoreToolNamesInSSELine(line, reverse = {}) {
  if (!String(line).startsWith('data:') || Object.keys(reverse).length === 0) return line
  const prefix = String(line).slice(0, String(line).indexOf('data:') + 5)
  const raw = String(line).slice(String(line).indexOf('data:') + 5).trim()
  let payload
  try { payload = JSON.parse(raw) } catch { return line }
  if (payload?.content_block?.type === 'tool_use' && reverse[payload.content_block.name]) {
    payload.content_block.name = reverse[payload.content_block.name]
  }
  if (payload?.delta?.type === 'tool_use' && reverse[payload.delta.name]) {
    payload.delta.name = reverse[payload.delta.name]
  }
  if (payload?.message) payload.message = restoreToolNames(payload.message, reverse)
  return `${prefix} ${JSON.stringify(payload)}`
}
