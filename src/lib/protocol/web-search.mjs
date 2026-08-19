/**
 * Claude server-side web search.
 *
 * Chat-style third parties (Hermes / RikkaHub / OpenClaw / …) usually omit
 * Anthropic's native server tool. Official Claude Code and protocol-compliance
 * clients (CCTest, SDKs, Go-http-client) already ship their own tool list —
 * leave those alone.
 *
 * Schema is Anthropic-only: { type: "web_search_20250305", name: "web_search" }.
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

const INJECT_CLIENT_CLASS = new Set(['hermes', 'openclaw'])
const INJECT_UA = /rikkahub|hermes|openclaw|clawdbot|moltbot|cherry[\s-]?studio|lobe-?chat|open-?webui|sillytavern/i

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

/**
 * Inject native web_search only for chat-style unofficial clients.
 * Protocol testers / SDKs / generic HTTP clients must not gain a server tool.
 */
export function shouldInjectClaudeWebSearch({ clientClass, headers } = {}) {
  if (INJECT_CLIENT_CLASS.has(String(clientClass || ''))) return true
  const ua = String(headers?.['user-agent'] || headers?.['User-Agent'] || '')
  return INJECT_UA.test(ua)
}

function toolChoiceNone(toolChoice) {
  if (toolChoice == null) return false
  if (toolChoice === 'none') return true
  return typeof toolChoice === 'object' && toolChoice.type === 'none'
}

/**
 * Append the native Claude web_search server tool when the inbound body has none.
 * No-ops when disabled, when the client already declared search, or when tool_choice is none.
 */
export function ensureClaudeWebSearch(body, { enabled = true } = {}) {
  if (!enabled || !body || typeof body !== 'object') return body
  if (toolChoiceNone(body.tool_choice)) return body
  if (hasClaudeWebSearch(body.tools)) return body
  const tools = Array.isArray(body.tools) ? [...body.tools] : []
  tools.push({ ...CLAUDE_WEB_SEARCH_TOOL })
  return { ...body, tools }
}
