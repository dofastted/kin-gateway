/**
 * Unofficial Anthropic request rectifier (sub2api FilterThinking / retry-filter analog).
 *
 * Official Claude Code may send assistant prefill and incomplete tool turns on purpose.
 * These fixes run on unofficial clients, plus always-on output_config schema fill.
 */

export const CONTINUE_USER_TEXT = 'continue'
export const MISSING_TOOL_RESULT_TEXT = 'Tool result unavailable.'

function clone(value) {
  return structuredClone(value)
}

function asBlocks(content) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function collectToolUseIds(content) {
  const ids = []
  for (const block of asBlocks(content)) {
    if (block?.type === 'tool_use' && block.id) ids.push(String(block.id))
  }
  return ids
}

function collectToolResultIds(content) {
  const ids = new Set()
  for (const block of asBlocks(content)) {
    if (block?.type === 'tool_result' && block.tool_use_id) ids.add(String(block.tool_use_id))
  }
  return ids
}

function placeholderResult(toolUseId) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: MISSING_TOOL_RESULT_TEXT,
  }
}

/** After assistant tool_use, the next user turn must include matching tool_result blocks. */
export function pairMissingToolResults(body = {}) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body
  const messages = body.messages.map((message) => ({ ...message }))
  let pending = []
  let changed = false

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const role = String(message?.role || '')
    if (role === 'assistant') {
      pending = pending.concat(collectToolUseIds(message.content))
      continue
    }
    if (role !== 'user' || pending.length === 0) continue
    const have = collectToolResultIds(message.content)
    const missing = pending.filter((id) => !have.has(id))
    pending = []
    if (!missing.length) continue
    const extras = missing.map(placeholderResult)
    if (Array.isArray(message.content)) {
      messages[i] = { ...message, content: [...extras, ...message.content] }
    } else if (typeof message.content === 'string') {
      messages[i] = {
        ...message,
        content: [...extras, { type: 'text', text: message.content }],
      }
    } else {
      messages[i] = { ...message, content: extras }
    }
    changed = true
  }

  if (pending.length) {
    messages.push({
      role: 'user',
      content: pending.map(placeholderResult),
    })
    changed = true
  }
  if (!changed) return body
  return { ...body, messages }
}

/** Anthropic unofficial path: conversation must end with a user turn (not assistant prefill). */
export function ensureConversationEndsWithUser(body = {}) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body
  const last = body.messages[body.messages.length - 1]
  if (String(last?.role || '') !== 'assistant') return body
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: 'user', content: [{ type: 'text', text: CONTINUE_USER_TEXT }] },
    ],
  }
}

function fillObjectSchema(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(fillObjectSchema)
  const out = { ...node }
  if (String(out.type || '').toLowerCase() === 'object' && out.additionalProperties == null) {
    out.additionalProperties = false
  }
  if (out.properties && typeof out.properties === 'object') {
    const next = {}
    for (const [key, value] of Object.entries(out.properties)) {
      next[key] = fillObjectSchema(value)
    }
    out.properties = next
  }
  if (out.items) out.items = fillObjectSchema(out.items)
  if (out.schema) out.schema = fillObjectSchema(out.schema)
  if (out.format && typeof out.format === 'object') out.format = fillObjectSchema(out.format)
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(fillObjectSchema)
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map(fillObjectSchema)
  return out
}

/** Missing additionalProperties on output_config JSON schema → 400. */
export function ensureOutputConfigSchema(body = {}) {
  const config = body.output_config
  if (!config || typeof config !== 'object') return body
  const next = fillObjectSchema(config)
  if (JSON.stringify(next) === JSON.stringify(config)) return body
  return { ...body, output_config: next }
}

export function rectifyUnofficialRequest(body = {}) {
  let out = clone(body)
  out = ensureOutputConfigSchema(out)
  out = pairMissingToolResults(out)
  out = ensureConversationEndsWithUser(out)
  return out
}
