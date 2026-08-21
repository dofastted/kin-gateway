import test from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  restoreToolNames,
  restoreToolNamesInSSELine,
  sanitizeAnthropicBodyForBetaTokens,
  anthropicBetaTokensContains,
  CONTEXT_MANAGEMENT_BETA,
  alignSamplingWithThinking,
} from '../../src/lib/protocol/anthropic-policy.mjs'

test('request policy strips empty blocks, caps cache controls and keeps forced-tool thinking', () => {
  const body = prepareAnthropicRequest({
    thinking: { type: 'enabled', budget_tokens: 1024 },
    tool_choice: { type: 'tool', name: 'run' },
    system: [
      { type: 'text', text: '', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    tools: [
      { name: 'run', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { name: 'read', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '' },
        { type: 'text', text: 'keep', cache_control: { type: 'ephemeral', ttl: '1h' } },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: '' }, { type: 'text', text: 'result' }],
        },
      ],
    }],
  }, { cacheControlLimit: 4 })
  assert.equal(body.thinking.type, 'enabled')
  assert.equal(body.thinking.budget_tokens, 1024)
  assert.equal(body.context_management.edits[0].type, 'clear_thinking_20251015')
  assert.equal(body.system.length, 1)
  assert.equal(body.messages[0].content[0].text, 'keep')
  assert.equal(body.messages[0].content[1].content.length, 1)
  const raw = JSON.stringify(body)
  const controls = raw.match(/cache_control/g) || []
  assert.ok(controls.length <= 4)
  assert.doesNotMatch(raw, /"ttl":"1h".*"ttl":"5m".*"ttl":"1h"/)
})

test('invalid tool names round-trip through response and SSE', () => {
  const original = {
    tools: [{ name: 'mcp.server/read file', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'mcp.server/read file' },
    messages: [{ role: 'user', content: 'read' }],
  }
  const rewritten = rewriteToolNames(original)
  const upstreamName = rewritten.body.tools[0].name
  assert.match(upstreamName, /^kin_tool_/)
  assert.equal(rewritten.body.tool_choice.name, upstreamName)
  const response = restoreToolNames({
    type: 'message',
    content: [{ type: 'tool_use', id: 'toolu_1', name: upstreamName, input: {} }],
  }, rewritten.reverse)
  assert.equal(response.content[0].name, 'mcp.server/read file')
  const line = restoreToolNamesInSSELine(
    `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', name: upstreamName } })}`,
    rewritten.reverse,
  )
  assert.match(line, /mcp\.server\/read file/)
})

test('unsigned and empty thinking blocks are stripped before hop', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-opus-5',
    thinking: { type: 'adaptive' },
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
        { type: 'thinking', thinking: 'no-sig' },
        { type: 'thinking', thinking: '', signature: 'sig_empty_text' },
        { type: 'thinking', thinking: 'dummy', signature: 'skip_thought_signature_validator' },
        { type: 'text', text: 'answer' },
      ],
    }],
  })
  assert.deepEqual(body.messages[0].content, [
    { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
    { type: 'text', text: 'answer' },
  ])
})

test('existing context_management is not overwritten', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-sonnet-5',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    context_management: { edits: [{ type: 'custom_strategy' }] },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(body.thinking.type, 'enabled')
  assert.deepEqual(body.context_management.edits, [{ type: 'custom_strategy' }])
})

test('sanitize strips context_management when final beta lacks the token', () => {
  const filled = prepareAnthropicRequest({
    model: 'claude-sonnet-5',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(filled.context_management.edits[0].type, 'clear_thinking_20251015')
  assert.equal(anthropicBetaTokensContains('oauth-2025-04-20', CONTEXT_MANAGEMENT_BETA), false)
  const stripped = sanitizeAnthropicBodyForBetaTokens(filled, 'oauth-2025-04-20,interleaved-thinking-2025-05-14')
  assert.equal(stripped.context_management, undefined)
  assert.equal(stripped.thinking.type, 'enabled')
  assert.equal(filled.context_management.edits[0].type, 'clear_thinking_20251015')
})

test('sanitize keeps context_management when final beta has the token', () => {
  const filled = prepareAnthropicRequest({
    model: 'claude-opus-5',
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  const header = `oauth-2025-04-20, ${CONTEXT_MANAGEMENT_BETA} ,interleaved-thinking-2025-05-14`
  const kept = sanitizeAnthropicBodyForBetaTokens(filled, header)
  assert.equal(kept.context_management.edits[0].type, 'clear_thinking_20251015')
})

test('OAuth defaults fill missing temperature and empty tools', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(body.temperature, 1)
  assert.deepEqual(body.tools, [])
  assert.equal(body.tool_choice, undefined)
})

test('thinking forces temperature=1 and drops top_p/top_k', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-sonnet-5',
    thinking: { type: 'adaptive' },
    temperature: 0,
    top_p: 0.9,
    top_k: 40,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(body.temperature, 1)
  assert.equal(body.top_p, undefined)
  assert.equal(body.top_k, undefined)
  const left = alignSamplingWithThinking({ temperature: 0.2, messages: [] })
  assert.equal(left.temperature, 0.2)
})

test('sanitize is a no-op when the body has no context_management', () => {
  const body = { model: 'claude-haiku-4-5', messages: [] }
  assert.equal(sanitizeAnthropicBodyForBetaTokens(body, ''), body)
  assert.equal(sanitizeAnthropicBodyForBetaTokens(body, CONTEXT_MANAGEMENT_BETA), body)
})

test('Haiku thinking.enabled does not inject context_management', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-haiku-4-5-20251001',
    thinking: { type: 'enabled', budget_tokens: 2000 },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(body.thinking.type, 'enabled')
  assert.equal(body.context_management, undefined)
})

test('Haiku inbound context_management is stripped', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-haiku-4-5',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(body.context_management, undefined)
})

test('valid unique tool names are not changed', () => {
  const result = rewriteToolNames({
    tools: [{ name: 'read_file' }, { name: 'write_file' }],
  })
  assert.deepEqual(result.body.tools.map((tool) => tool.name), ['read_file', 'write_file'])
})
