import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_WEB_SEARCH_TOOL,
  ensureClaudeWebSearch,
  hasClaudeWebSearch,
  isAnthropicServerTool,
  isWebSearchTool,
  shouldInjectClaudeWebSearch,
} from '../../src/lib/protocol/web-search.mjs'
import { openaiToolsToClaude, toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { rewriteToolNames } from '../../src/lib/protocol/anthropic-policy.mjs'

test('ensureClaudeWebSearch appends native server tool when missing', () => {
  const out = ensureClaudeWebSearch({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
  })
  assert.equal(out.tools.length, 2)
  assert.deepEqual(out.tools[1], { type: 'web_search_20250305', name: 'web_search' })
})

test('ensureClaudeWebSearch is a no-op when search already present', () => {
  const body = {
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  }
  const out = ensureClaudeWebSearch(body)
  assert.equal(out.tools.length, 1)
  assert.equal(out, body)
})

test('ensureClaudeWebSearch respects tool_choice none', () => {
  const out = ensureClaudeWebSearch({ tool_choice: { type: 'none' } })
  assert.equal(out.tools, undefined)
  assert.equal(ensureClaudeWebSearch({ tool_choice: 'none' }).tools, undefined)
})

test('ensureClaudeWebSearch disabled leaves tools unchanged', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  const out = ensureClaudeWebSearch(body, { enabled: false })
  assert.equal(out, body)
  assert.equal(out.tools, undefined)
})

test('shouldInjectClaudeWebSearch only for chat-style unofficial clients', () => {
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'hermes' }), true)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'openclaw' }), true)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'RikkaHub-Android/2.4.10' } }), true)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'Cherry Studio/1.0' } }), true)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'Lobe-Chat/1.0' } }), true)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'unknown' }), false)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'third_party_sdk' }), false)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'Go-http-client/1.1' } }), false)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'python-requests/2.32' } }), false)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'OpenAI/Python 1.40' } }), false)
  assert.equal(shouldInjectClaudeWebSearch({ headers: { 'user-agent': 'curl/8.6.0' } }), false)
  assert.equal(shouldInjectClaudeWebSearch({ clientClass: 'claude_code_official' }), false)
})

test('OpenAI web_search type is not dropped during convert', () => {
  const tools = openaiToolsToClaude([
    { type: 'web_search' },
    { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
    { type: 'web_search_preview' },
  ])
  assert.deepEqual(tools[0], CLAUDE_WEB_SEARCH_TOOL)
  assert.equal(tools.filter((t) => t.name === 'web_search').length, 1)
  assert.equal(tools[1].name, 'lookup')
})

test('openai.chat convert injects mapped search then caller can ensure', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'news?' }],
    tools: [{ type: 'web_search' }],
  })
  assert.ok(hasClaudeWebSearch(claude.tools))
  assert.deepEqual(claude.tools[0], CLAUDE_WEB_SEARCH_TOOL)
})

test('rewriteToolNames skips Anthropic server tools', () => {
  const result = rewriteToolNames({
    tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'mcp.server/read file', input_schema: { type: 'object' } },
    ],
  })
  assert.equal(result.body.tools[0].name, 'web_search')
  assert.equal(result.body.tools[0].type, 'web_search_20250305')
  assert.match(result.body.tools[1].name, /^kin_tool_/)
})

test('isWebSearchTool / isAnthropicServerTool', () => {
  assert.equal(isWebSearchTool({ type: 'web_search_20250305', name: 'web_search' }), true)
  assert.equal(isWebSearchTool({ type: 'google_search' }), true)
  assert.equal(isWebSearchTool({ name: 'read_file' }), false)
  assert.equal(isAnthropicServerTool({ type: 'web_search_20250305', name: 'web_search' }), true)
  assert.equal(isAnthropicServerTool({ name: 'read_file' }), false)
  assert.equal(isAnthropicServerTool({ type: 'custom', name: 'Read' }), false)
})
