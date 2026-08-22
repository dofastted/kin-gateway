import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCrsUnofficialPersona, CRS_OFFICIAL_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import {
  estimateClaudeInputTokens,
  hidePersonaUsage,
  hidePersonaUsageInSseLine,
  hidePersonaUsageOnMessage,
  personaHideInputTokens,
} from '../../src/lib/identity/crs-persona-usage.mjs'

const helloBody = { messages: [{ role: 'user', content: 'hello' }] }

test('rewrite 3-block hide estimate covers observed short-request 554', () => {
  const after = applyCrsUnofficialPersona(helloBody, { mode: 'rewrite' })
  const hide = personaHideInputTokens(helloBody, after)
  assert.ok(hide >= 554, `hide=${hide}`)
  const hidden = hidePersonaUsage({ input_tokens: 554, output_tokens: 8, total_tokens: 562 }, hide)
  assert.equal(hidden.input_tokens, 0)
  assert.equal(hidden.cache_read_input_tokens, 554)
  assert.equal(hidden.output_tokens, 8)
  assert.equal(hidden.total_tokens, 8)
})

test('official client same-object skip hides nothing', () => {
  const body = {
    system: [{ type: 'text', text: CRS_OFFICIAL_SYSTEM }],
    messages: [{ role: 'user', content: 'hello' }],
  }
  const after = applyCrsUnofficialPersona(body, { officialClient: true })
  assert.equal(after, body)
  assert.equal(personaHideInputTokens(body, after), 0)
})

test('none mode hides nothing', () => {
  const before = { system: 'keep me', messages: helloBody.messages }
  const after = applyCrsUnofficialPersona(before, { mode: 'none' })
  assert.equal(personaHideInputTokens(before, after), 0)
})

test('append only hides the official one-liner', () => {
  const before = { system: 'You are in Xcode.', messages: helloBody.messages }
  const after = applyCrsUnofficialPersona(before, { mode: 'append' })
  const hide = personaHideInputTokens(before, after)
  assert.equal(hide, estimateClaudeInputTokens(CRS_OFFICIAL_SYSTEM))
  assert.ok(hide < 80)
})

test('cache read stays; leftover official input is appended to cache_read', () => {
  const hidden = hidePersonaUsage({
    input_tokens: 20,
    cache_read_input_tokens: 534,
    cache_creation_input_tokens: 0,
    output_tokens: 11,
    total_tokens: 31,
  }, 556)
  assert.equal(hidden.cache_read_input_tokens, 554)
  assert.equal(hidden.input_tokens, 0)
  assert.equal(hidden.output_tokens, 11)
  assert.equal(hidden.total_tokens, 11)
})

test('cache creation stays; leftover official input is appended to cache_creation', () => {
  const hidden = hidePersonaUsage({
    input_tokens: 54,
    cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 500 },
    output_tokens: 7,
    total_tokens: 61,
  }, 556)
  assert.equal(hidden.cache_creation_input_tokens, 554)
  assert.equal(hidden.cache_creation.ephemeral_5m_input_tokens, 554)
  assert.equal(hidden.input_tokens, 0)
  assert.equal(hidden.cache_read_input_tokens, undefined)
})

test('long caller input keeps remainder after official hide', () => {
  const hidden = hidePersonaUsage({
    input_tokens: 2000,
    cache_read_input_tokens: 534,
    output_tokens: 40,
    total_tokens: 2040,
  }, 556)
  assert.equal(hidden.cache_read_input_tokens, 556)
  assert.equal(hidden.input_tokens, 2000 - (556 - 534))
  assert.equal(hidden.output_tokens, 40)
})

test('SSE message_start input_tokens 554 becomes cache_read', () => {
  const after = applyCrsUnofficialPersona(helloBody, { mode: 'rewrite' })
  const hide = personaHideInputTokens(helloBody, after)
  const line = 'data: {"type":"message_start","message":{"usage":{"input_tokens":554,"output_tokens":0}}}'
  const out = hidePersonaUsageInSseLine(line, hide)
  const evt = JSON.parse(out.slice(out.indexOf('{')))
  assert.equal(evt.message.usage.input_tokens, 0)
  assert.equal(evt.message.usage.cache_read_input_tokens, 554)
  assert.equal(evt.message.usage.output_tokens, 0)
})

test('non-stream message usage is rewritten without mutating the log copy', () => {
  const raw = { usage: { input_tokens: 554, output_tokens: 9 } }
  const client = hidePersonaUsageOnMessage(raw, 556)
  assert.equal(client.usage.input_tokens, 0)
  assert.equal(client.usage.cache_read_input_tokens, 554)
  assert.equal(raw.usage.input_tokens, 554)
  assert.equal(raw.usage.cache_read_input_tokens, undefined)
})
