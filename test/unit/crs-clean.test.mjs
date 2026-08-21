import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAnthropicBody, normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { toClaudeMessages, fromClaudeToOpenAICompletions, fromClaudeToOpenAIChat, fromClaudeToResponses } from '../../src/lib/protocol/convert.mjs'
import { applyCrsIdentityReplace, uuidFromSeed } from '../../src/lib/identity/identity-rewrite.mjs'
import { applyCrsUnofficialPersona, CRS_OFFICIAL_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'

test('sanitize keeps official context_management and maps stop → stop_sequences', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    stop: ['END'],
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    settings: { theme: 'light' },
  })
  assert.deepEqual(out.stop_sequences, ['END'])
  assert.equal(out.stop, undefined)
  assert.equal(out.settings, undefined)
  assert.equal(out.context_management.edits[0].keep, 'all')
})

test('sanitize passthrough keeps output_config and drops OpenAI leftovers', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    output_config: {
      format: { type: 'json_schema', schema: { type: 'object', properties: { price: { type: 'number' } } } },
      effort: 'medium',
    },
    output_format: { type: 'json_schema' },
    container: { id: 'cntr_1' },
    mcp_servers: [{ name: 'files', type: 'url', url: 'https://example.invalid' }],
    service_tier: 'auto',
    extra_body: { should_drop: true },
    settings: { theme: 'light' },
    n: 1,
    response_format: { type: 'json_object' },
  })
  assert.equal(out.output_config.effort, 'medium')
  assert.equal(out.output_config.format.type, 'json_schema')
  assert.equal(out.output_format.type, 'json_schema')
  assert.equal(out.container.id, 'cntr_1')
  assert.equal(out.mcp_servers[0].name, 'files')
  assert.equal(out.service_tier, 'auto')
  assert.equal(out.extra_body, undefined)
  assert.equal(out.settings, undefined)
  assert.equal(out.n, undefined)
  assert.equal(out.response_format, undefined)
})

test('sanitize remaps unknown Anthropic roles to user (sub2api admin→user)', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'admin', content: 'x' }],
  })
  assert.deepEqual(out.messages, [{ role: 'user', content: 'x' }])
})

test('sanitize lifts system/developer turns and merges consecutive users', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32,
    system: 'base',
    messages: [
      { role: 'system', content: 'extra rule' },
      { role: 'developer', content: 'dev note' },
      { role: 'user', content: 'one' },
      { role: 'admin', content: 'two' },
      { role: 'assistant', content: 'ok' },
    ],
  })
  assert.equal(out.system, 'base\n\nextra rule\n\ndev note')
  assert.deepEqual(out.messages, [
    { role: 'user', content: 'one\ntwo' },
    { role: 'assistant', content: 'ok' },
  ])
})

test('sanitize drops empty content and prefixes assistant-first history', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    messages: [
      { role: 'admin', content: '   ' },
      { role: 'assistant', content: 'hello' },
    ],
  })
  assert.equal(out.messages[0].role, 'user')
  assert.equal(out.messages[0].content, '.')
  assert.equal(out.messages[1].role, 'assistant')
  assert.equal(out.messages[1].content, 'hello')
})

test('strict passthrough keeps invalid roles for official wire', () => {
  const out = sanitizeAnthropicBody({
    model: 'claude-sonnet-5',
    max_tokens: 8,
    messages: [{ role: 'admin', content: 'x' }],
  }, { strictPassthrough: true })
  assert.equal(out.messages[0].role, 'admin')
})

test('toClaudeMessages anthropic passthrough remaps admin role', () => {
  const { claude, mode } = toClaudeMessages('anthropic.messages', {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'admin', content: 'x' }],
  })
  assert.equal(mode, 'passthrough')
  assert.equal(claude.messages[0].role, 'user')
  assert.equal(claude.messages[0].content, 'x')
})

test('officialMessagesBody remaps admin before the worker hop', () => {
  const out = officialMessagesBody({
    model: 'claude-sonnet-5',
    max_tokens: 64,
    messages: [{ role: 'admin', content: 'x' }],
  })
  assert.equal(out.messages[0].role, 'user')
})

test('normalizeAnthropicMessages is idempotent for legal turns', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
    ],
  }
  normalizeAnthropicMessages(body)
  normalizeAnthropicMessages(body)
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
  ])
})

test('third-party persona rewrites to 3-block system and parks caller system', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-haiku-4-5-20251001',
    messages: [
      { role: 'system', content: 'you are a linter' },
      { role: 'user', content: 'hi' },
    ],
    stop: 'END',
    max_tokens: 16,
  })
  assert.deepEqual(claude.stop_sequences, ['END'])
  const cleaned = applyCrsUnofficialPersona(claude, { officialClient: false })
  assert.equal(cleaned.system.length, 3)
  assert.equal(cleaned.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.match(cleaned.messages[0].content[0].text, /you are a linter/)
})

test('empty unofficial system becomes the 3-block Claude Code shape', () => {
  const out = applyCrsUnofficialPersona({ messages: [] }, { officialClient: false })
  assert.equal(out.system.length, 3)
  assert.equal(out.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.equal(out.messages.length, 0)
})

test('official Claude Code system is not replaced or appended', () => {
  const body = { system: [{ type: 'text', text: 'x'.repeat(200) }], messages: [] }
  const out = applyCrsUnofficialPersona(body, { officialClient: true })
  assert.equal(out.system[0].text.length, 200)
  assert.equal(out.system.length, 1)
})

test('Xcode unofficial system is parked and official 3-block system is written', () => {
  const body = { system: 'You are currently in Xcode. Help with Swift.', messages: [] }
  const out = applyCrsUnofficialPersona(body, { officialClient: false })
  assert.equal(out.system.length, 3)
  assert.equal(out.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.match(out.messages[0].content[0].text, /Xcode/)
})

test('legacy user_id: device becomes VM, session is CRS-hashed, account from OAuth', () => {
  const inbound = { metadata: { user_id: 'user_devA_account__session_sess9' } }
  const out = applyCrsIdentityReplace({ model: 'x' }, {
    accountUuid: 'acc-1',
    deviceId: 'vm',
    vmId: 'vm-01',
    metadataUserId: JSON.stringify({ device_id: 'vm', account_uuid: 'acc-1', session_id: 'vm-sess' }),
  }, inbound)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, 'vm')
  assert.equal(uid.account_uuid, 'acc-1')
  assert.equal(uid.session_id, uuidFromSeed('acc-1::sess9'))
})

test('openai.completions prompt converts to Claude user message', () => {
  const { claude } = toClaudeMessages('openai.completions', {
    model: 'claude-haiku-4-5-20251001',
    prompt: 'Complete this: hello',
    max_tokens: 16,
    stop: ['\n'],
  })
  assert.equal(claude.messages[0].role, 'user')
  assert.match(String(claude.messages[0].content), /Complete this: hello/)
  assert.deepEqual(claude.stop_sequences, ['\n'])
  const back = fromClaudeToOpenAICompletions({
    content: [{ type: 'text', text: 'world' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 1 },
  }, 'claude-haiku-4-5-20251001')
  assert.equal(back.object, 'text_completion')
  assert.equal(back.choices[0].text, 'world')
  assert.equal(back.choices[0].finish_reason, 'stop')
})

test('OpenAI chat usage carries prompt_tokens_details cache breakdown', () => {
  const claude = {
    id: 'msg_1',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
    },
  }
  const out = fromClaudeToOpenAIChat(claude, 'claude-haiku-4-5-20251001', 'vm-1', 'convert')
  assert.equal(out.usage.prompt_tokens, 10)
  assert.equal(out.usage.completion_tokens, 4)
  assert.deepEqual(out.usage.prompt_tokens_details, { cached_tokens: 3, cache_creation_tokens: 7 })
})

test('OpenAI chat usage omits details when no cache tokens', () => {
  const claude = {
    id: 'msg_1',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4 },
  }
  const out = fromClaudeToOpenAIChat(claude, 'claude-haiku-4-5-20251001', 'vm-1', 'convert')
  assert.equal(out.usage.prompt_tokens_details, undefined)
})

test('OpenAI responses usage carries input_tokens_details cache breakdown', () => {
  const claude = {
    id: 'msg_1',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
  }
  const out = fromClaudeToResponses(claude, 'claude-haiku-4-5-20251001', 'vm-1', 'convert')
  assert.equal(out.usage.input_tokens, 10)
  assert.deepEqual(out.usage.input_tokens_details, { cached_tokens: 2 })
})

test('OpenAI response_format.json_schema maps to output_config', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'color' }],
    max_tokens: 64,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'colors',
        schema: { type: 'object', properties: { top_left: { type: 'string' } } },
      },
    },
  })
  assert.equal(claude.output_config.format.type, 'json_schema')
  assert.equal(claude.output_config.format.name, 'colors')
  assert.equal(claude.output_config.format.schema.properties.top_left.type, 'string')
})

test('OpenAI chat maps Anthropic refusal instead of silent stop', () => {
  const out = fromClaudeToOpenAIChat({
    content: [{ type: 'refusal', refusal: 'no' }],
    stop_reason: 'refusal',
    usage: { input_tokens: 8, output_tokens: 0 },
  }, 'claude-opus-5', 'vm-1', 'convert')
  assert.equal(out.choices[0].finish_reason, 'content_filter')
  assert.equal(out.choices[0].message.refusal, 'no')
  assert.equal(out.choices[0].message.content, 'no')
})

test('OpenAI response_format survives Anthropic sanitize as output_config', () => {
  const native = officialMessagesBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'json' }],
    max_tokens: 32,
    response_format: { type: 'json_object' },
  })
  assert.equal(native.output_config.format.type, 'json_schema')
  assert.equal(native.response_format, undefined)
})

test('officialMessagesBody fills missing max_tokens with 128000', () => {
  const out = officialMessagesBody({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(out.max_tokens, 128000)
})
