import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_1M_BETA,
  DEFAULT_CONTEXT_1M_WHITELIST,
  hasClaudeCode1mSuffix,
  shouldPassContext1m,
  stripClaudeCode1mSuffix,
} from '../../src/lib/protocol/context-1m.mjs'
import { applyBetaPolicyToHeader, normalizePolicy, resolveContext1mPass, seedDefaultPolicy, normalizeThinkingByPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { normalizeThinkingForModel } from '../../src/lib/protocol/thinking.mjs'

test('stripClaudeCode1mSuffix only peels a trailing literal suffix', () => {
  assert.equal(stripClaudeCode1mSuffix('claude-opus-4-8[1m]'), 'claude-opus-4-8')
  assert.equal(stripClaudeCode1mSuffix('claude-opus-4-8[1M][1m]'), 'claude-opus-4-8')
  assert.equal(stripClaudeCode1mSuffix('claude-opus-4-8[1m]-preview'), 'claude-opus-4-8[1m]-preview')
  assert.equal(stripClaudeCode1mSuffix('[1m]'), '[1m]')
  assert.equal(hasClaudeCode1mSuffix('opus[1m]'), true)
  assert.equal(hasClaudeCode1mSuffix('opus[1]'), false)
})

test('shouldPassContext1m default whitelist matches sonnet-5 only', () => {
  const pass = [
    'claude-sonnet-5',
    'claude-sonnet-5-20260701',
    'claude-sonnet-5-thinking',
    'claude-sonnet-5[1m]',
    'anthropic/claude-sonnet-5',
  ]
  const drop = [
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-sonnet-50',
    'claude-3-5-sonnet-20241022',
  ]
  for (const model of pass) assert.equal(shouldPassContext1m(model), true, model)
  for (const model of drop) assert.equal(shouldPassContext1m(model), false, model)
})

test('context_1m_whitelist is policy-configurable', () => {
  const seed = seedDefaultPolicy()
  assert.deepEqual(seed.defaults.context_1m_whitelist, [...DEFAULT_CONTEXT_1M_WHITELIST])

  const upgraded = normalizePolicy({ defaults: { max_tokens: 8192 } })
  assert.deepEqual(upgraded.defaults.context_1m_whitelist, [...DEFAULT_CONTEXT_1M_WHITELIST])

  const custom = normalizePolicy({
    defaults: { context_1m_whitelist: ['claude-opus-5', 'claude-fable-5-*', ''] },
  })
  assert.deepEqual(custom.defaults.context_1m_whitelist, ['claude-opus-5', 'claude-fable-5-*'])
  assert.equal(shouldPassContext1m('claude-opus-5', custom.defaults.context_1m_whitelist), true)
  assert.equal(shouldPassContext1m('claude-fable-5-preview', custom.defaults.context_1m_whitelist), true)
  assert.equal(shouldPassContext1m('claude-sonnet-5', custom.defaults.context_1m_whitelist), false)

  const header = `${CONTEXT_1M_BETA},oauth-2025-04-20`
  assert.match(
    applyBetaPolicyToHeader(header, 'claude-opus-5', { isOfficial: true, whitelist: ['claude-opus-5'] }),
    /context-1m-2025-08-07/,
  )
  assert.doesNotMatch(
    applyBetaPolicyToHeader(header, 'claude-sonnet-5', { isOfficial: true, whitelist: ['claude-opus-5'] }),
    /context-1m-2025-08-07/,
  )
})

test('normalizePolicy upgrades stale sonnet-5 convert_to_adaptive and missing 1m flag', () => {
  const n = normalizePolicy({
    models: {
      'claude-sonnet-5': {
        params: { on_enabled: 'convert_to_adaptive', on_adaptive: 'passthrough' },
        betas: { required: ['oauth-2025-04-20'] },
      },
    },
  })
  assert.equal(n.models['claude-sonnet-5'].params.on_enabled, 'passthrough')
  assert.equal(n.models['claude-sonnet-5'].betas.pass_context_1m, true)
  assert.equal(n.models['claude-opus-5'].betas.pass_context_1m, false)
  assert.equal(n.models['claude-fable-5'].betas.pass_context_1m, false)
})

test('matrix pass_context_1m wins over fallback whitelist', () => {
  const seed = seedDefaultPolicy()
  assert.equal(seed.models['claude-sonnet-5'].betas.pass_context_1m, true)
  assert.equal(seed.models['claude-opus-5'].betas.pass_context_1m, false)
  assert.equal(seed.models['claude-fable-5'].betas.pass_context_1m, false)

  assert.equal(resolveContext1mPass('claude-sonnet-5', {
    entry: seed.models['claude-sonnet-5'],
    whitelist: [],
  }), true)

  assert.equal(resolveContext1mPass('claude-opus-5', {
    entry: seed.models['claude-opus-5'],
    whitelist: ['claude-opus-5'],
  }), false)

  assert.equal(resolveContext1mPass('claude-sonnet-5', {
    entry: { betas: { pass_context_1m: false } },
    whitelist: [...DEFAULT_CONTEXT_1M_WHITELIST],
  }), false)

  assert.equal(resolveContext1mPass('claude-sonnet-5-20260701', {
    entry: { _heuristic: true },
    whitelist: [...DEFAULT_CONTEXT_1M_WHITELIST],
  }), true)
})

test('official beta policy passes 1m on sonnet-5 and filters others', () => {
  const header = `${CONTEXT_1M_BETA},oauth-2025-04-20`
  assert.match(applyBetaPolicyToHeader(header, 'claude-sonnet-5', { isOfficial: true }), /context-1m-2025-08-07/)
  assert.match(applyBetaPolicyToHeader(header, 'claude-sonnet-5-20260701', { isOfficial: true }), /context-1m-2025-08-07/)
  assert.doesNotMatch(applyBetaPolicyToHeader(header, 'claude-opus-5', { isOfficial: true }), /context-1m-2025-08-07/)
  assert.doesNotMatch(applyBetaPolicyToHeader(header, 'claude-fable-5', { isOfficial: true }), /context-1m-2025-08-07/)
  assert.doesNotMatch(applyBetaPolicyToHeader(header, 'claude-haiku-4-5-20251001', { isOfficial: true }), /context-1m-2025-08-07/)
})

test('unofficial mimic never keeps context-1m even on sonnet-5', () => {
  const header = `${CONTEXT_1M_BETA},oauth-2025-04-20`
  assert.doesNotMatch(applyBetaPolicyToHeader(header, 'claude-sonnet-5', { isOfficial: false }), /context-1m-2025-08-07/)
})

test('OAuth thinking keeps enabled on Claude 5 / Fable and converts Haiku adaptive', () => {
  const sonnet = normalizeThinkingForModel({
    model: 'claude-sonnet-5',
    thinking: { type: 'enabled', budget_tokens: 8000 },
  })
  assert.equal(sonnet.thinking.type, 'enabled')
  assert.equal(sonnet.thinking.budget_tokens, 8000)

  const fable = normalizeThinkingForModel({
    model: 'claude-fable-5',
    thinking: { type: 'enabled', budget_tokens: 4000 },
  })
  assert.equal(fable.thinking.type, 'enabled')
  assert.equal(fable.thinking.budget_tokens, 4000)

  const opus = normalizeThinkingForModel({
    model: 'claude-opus-5',
    thinking: { type: 'enabled', budget_tokens: 2000 },
  })
  assert.equal(opus.thinking.type, 'enabled')

  const haiku = normalizeThinkingByPolicy({
    model: 'claude-haiku-4-5-20251001',
    thinking: { type: 'adaptive' },
  })
  assert.equal(haiku.thinking.type, 'enabled')
  assert.ok(haiku.thinking.budget_tokens > 0)

  const seed = seedDefaultPolicy()
  assert.equal(seed.models['claude-sonnet-5'].params.on_enabled, 'passthrough')
  assert.equal(seed.models['claude-fable-5'].params.on_enabled, 'passthrough')
  assert.equal(seed.models['claude-opus-5'].params.on_enabled, 'passthrough')
})
