import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyUpstreamResult,
  repairAnthropicRequest,
  shouldContinue,
} from '../../src/lib/upstream-error-policy.mjs'

test('unified account 429 cools account until authoritative reset', () => {
  const now = 1_700_000_000_000
  const reset = now + 120_000
  const policy = classifyUpstreamResult({
    status: 429,
    body: { type: 'error', error: { type: 'rate_limit_error', message: 'limited' } },
    headers: {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(reset),
    },
  }, { model: 'claude-opus-test', now })
  assert.equal(policy.scope, 'account')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.cooldownUntil, reset)
  assert.equal(shouldContinue(policy), true)
})

test('model 429 only cools requested model', () => {
  const policy = classifyUpstreamResult({
    status: 429,
    body: { error: { type: 'rate_limit_error', message: 'model capacity' } },
    headers: {},
  }, { model: 'claude-sonnet-test', now: 1000 })
  assert.equal(policy.scope, 'model')
  assert.equal(policy.model, 'claude-sonnet-test')
  assert.equal(policy.cooldownUntil, 61_000)
})

test('entitlement 429 stops without poisoning pool', () => {
  const policy = classifyUpstreamResult({
    status: 429,
    body: { error: { message: 'Usage credits are required for fast mode' } },
  }, { model: 'claude-opus-test' })
  assert.equal(policy.scope, 'request')
  assert.equal(policy.action, 'stop')
})

test('committed incomplete stream never switches account', () => {
  const policy = classifyUpstreamResult({
    status: 200,
    ok: false,
    committed: true,
    terminalState: 'incomplete',
  })
  assert.equal(policy.scope, 'stream')
  assert.equal(policy.action, 'stop')
})

test('transport proxy error rotates with proxy cooldown', () => {
  const policy = classifyUpstreamResult({
    status: 0,
    transportError: true,
    body: { error: { code: 'worker_transport_error', message: 'SOCKS proxy dial failed' } },
  }, { now: 1000 })
  assert.equal(policy.scope, 'proxy')
  assert.equal(policy.action, 'continue-and-cooldown')
})

test('signature error has one scoped repair', () => {
  const policy = classifyUpstreamResult({
    status: 400,
    body: { error: { message: 'thinking.signature: Field required' } },
  }, { repaired: false })
  assert.equal(policy.action, 'repair-and-retry')
  const body = repairAnthropicRequest({
    thinking: { type: 'enabled', budget_tokens: 1000 },
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: 'keep' },
      ],
    }],
  }, policy)
  assert.equal(body.thinking, undefined)
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'keep' }])
  const second = classifyUpstreamResult({
    status: 400,
    body: { error: { message: 'thinking.signature: Field required' } },
  }, { repaired: true })
  assert.equal(second.action, 'stop')
})
