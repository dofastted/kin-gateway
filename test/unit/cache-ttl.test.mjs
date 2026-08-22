import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCacheTtlToBody,
  applyCacheTtlToUsage,
  DEFAULT_CACHE_TTL,
  normalizeCacheTtl,
  resolveCacheTtl,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'

test('default and aliases normalize to 5m or 1h', () => {
  assert.equal(normalizeCacheTtl(undefined), DEFAULT_CACHE_TTL)
  assert.equal(normalizeCacheTtl('5m'), '5m')
  assert.equal(normalizeCacheTtl('1h'), '1h')
  assert.equal(normalizeCacheTtl('1hour'), '1h')
  assert.equal(normalizeCacheTtl('bogus'), '5m')
})

test('header overrides routing default', () => {
  assert.equal(resolveCacheTtl({ headers: { 'x-kin-cache-ttl': '1h' }, routing: { compatibility: { cache_ttl: '5m' } } }), '1h')
  assert.equal(resolveCacheTtl({ headers: {}, routing: { compatibility: { cache_ttl: '1h' } } }), '1h')
  assert.equal(resolveCacheTtl({ headers: {}, routing: { compatibility: {} } }), '5m')
})

test('applyCacheTtlToBody forces ephemeral ttl', () => {
  const out = applyCacheTtlToBody({
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] }],
  }, '1h')
  assert.equal(out.system[0].cache_control.ttl, '1h')
  assert.equal(out.tools[0].cache_control.ttl, '1h')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '1h')
})

test('1h request without breakdown bills the 1h rate not 5m', () => {
  const as5m = calculateCost({ cache_creation_tokens: 1_000_000 }, 'claude-sonnet-5')
  const as1h = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '1h' }, 'claude-sonnet-5')
  assert.equal(as5m.cache_creation_cost, 2.5)
  assert.equal(as1h.cache_creation_cost, 4)
  assert.equal(as1h.cache_creation_1h_tokens, 1_000_000)
  assert.equal(as1h.total_cost - as5m.total_cost, 1.5)
})

test('applyCacheTtlToUsage reclassifies a 5m report after we sent 1h', () => {
  const out = applyCacheTtlToUsage({
    cache_creation_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
  }, '1h')
  assert.equal(out.cache_creation_1h_tokens, 2000)
  assert.equal(out.cache_creation_5m_tokens, 0)
  assert.equal(out.cache_ttl, '1h')
})
