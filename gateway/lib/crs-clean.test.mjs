import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeAnthropicBody } from './sanitize.mjs'
import { toClaudeMessages, fromClaudeToOpenAICompletions } from './convert.mjs'
import { applyCrsIdentityReplace, uuidFromSeed } from './forward-mode.mjs'
import { applyCrsUnofficialPersona, CRS_OFFICIAL_SYSTEM } from './crs-persona.mjs'

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

test('third-party persona appends official line and keeps caller system', () => {
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
  assert.match(cleaned.system, /you are a linter/)
  assert.match(cleaned.system, new RegExp(CRS_OFFICIAL_SYSTEM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('empty unofficial system becomes the official one-liner', () => {
  const out = applyCrsUnofficialPersona({ messages: [] }, { officialClient: false })
  assert.equal(out.system, CRS_OFFICIAL_SYSTEM)
})

test('official Claude Code system is not replaced or appended', () => {
  const body = { system: [{ type: 'text', text: 'x'.repeat(200) }], messages: [] }
  const out = applyCrsUnofficialPersona(body, { officialClient: true })
  assert.equal(out.system[0].text.length, 200)
  assert.equal(out.system.length, 1)
})

test('Xcode unofficial system keeps Xcode and appends official line', () => {
  const body = { system: 'You are currently in Xcode. Help with Swift.' }
  const out = applyCrsUnofficialPersona(body, { officialClient: false })
  assert.match(out.system, /Xcode/)
  assert.match(out.system, /Claude Code/)
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
