/**
 * Claude server-side web search.
 *
 * Third-party clients (Chat/OpenAI/Hermes/…) usually omit Anthropic's native
 * server tool. Official Claude Code already ships its own tool list — leave it
 * alone. Schema is Anthropic-only: { type: "web_search_20250305", name: "web_search" }.
 */

export const CLAUDE_WEB_SEARCH_TOOL = Object.freeze({
  type: 'web_search_20250305',
  name: 'web_search',
})

const WEB_SEARCH_NAMES = new Set([
  'web_search',
  'web_search_20250305',
  'WebSearch',
  'google_search',
])

export function isWebSearchTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  const type = String(tool.type || '')
  const name = String(tool.name || tool.function?.name || '')
  return type.startsWith('web_search') || type === 'google_search' || WEB_SEARCH_NAMES.has(name)
}

export function isAnthropicServerTool(tool) {
  const type = String(tool?.type || '')
  return type !== '' && type !== 'function' && type !== 'custom'
}

export function hasClaudeWebSearch(tools) {
  return Array.isArray(tools) && tools.some(isWebSearchTool)
}

function toolChoiceNone(toolChoice) {
  if (toolChoice == null) return false
  if (toolChoice === 'none') return true
  return typeof toolChoice === 'object' && toolChoice.type === 'none'
}

/**
 * Append the native Claude web_search server tool when the inbound body has none.
 * No-ops when the client already declared search, or when tool_choice is none.
 */
export function ensureClaudeWebSearch(body, { enabled = true } = {}) {
  if (!enabled || !body || typeof body !== 'object') return body
  if (toolChoiceNone(body.tool_choice)) return body
  if (hasClaudeWebSearch(body.tools)) return body
  const tools = Array.isArray(body.tools) ? [...body.tools] : []
  tools.push({ ...CLAUDE_WEB_SEARCH_TOOL })
  return { ...body, tools }
}
