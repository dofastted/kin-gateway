import crypto from 'node:crypto'
import { isAnthropicServerTool } from './web-search.mjs'

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

function forcedToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return false
  return toolChoice.type === 'tool' || toolChoice.type === 'any'
}

export function prepareAnthropicRequest(body = {}, {
  cacheControlLimit = 4,
} = {}) {
  const out = clone(body)
  if (Array.isArray(out.system)) {
    out.system = cleanContent(out.system)
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => ({
      ...message,
      content: cleanContent(message?.content),
    }))
  }
  if (forcedToolChoice(out.tool_choice) && out.thinking?.type === 'enabled') {
    delete out.thinking
  }
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
