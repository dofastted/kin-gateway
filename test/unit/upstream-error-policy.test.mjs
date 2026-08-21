import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyUpstreamResult,
  repairAnthropicRequest,
  shouldContinue,
} from '../../src/lib/pool/upstream-error-policy.mjs'

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

test('response-header timeout does not cool the account', () => {
  const policy = classifyUpstreamResult({
    status: 502,
    body: {
      error: {
        type: 'api_error',
        code: 'upstream_transport_error',
        message: 'net/http: timeout awaiting response headers',
      },
    },
  }, { now: 1000 })
  assert.equal(policy.scope, 'provider')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'provider_timeout')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.retrySameAccount, true)
  assert.equal(shouldContinue(policy), true)
})

test('generic 502/5xx can failover without account cooldown', () => {
  const policy = classifyUpstreamResult({
    status: 502,
    body: { error: { type: 'api_error', message: 'Upstream service temporarily unavailable' } },
  }, { now: 1000 })
  assert.equal(policy.action, 'continue')
  assert.equal(policy.cooldownUntil, null)
  assert.equal(policy.retrySameAccount, true)
})

test('transport timeout is not treated as a dead proxy', () => {
  const policy = classifyUpstreamResult({
    status: 0,
    transportError: true,
    body: { error: { code: 'upstream_transport_error', message: 'SOCKS connection timed out' } },
  }, { now: 1000 })
  assert.equal(policy.scope, 'worker')
  assert.equal(policy.action, 'continue')
  assert.equal(policy.reason, 'worker_timeout')
  assert.equal(policy.cooldownUntil, null)
})

test('529 still uses a short provider cooldown', () => {
  const policy = classifyUpstreamResult({
    status: 529,
    body: { error: { type: 'overloaded_error', message: 'Overloaded' } },
  }, { now: 1000 })
  assert.equal(policy.scope, 'provider')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.reason, 'provider_overloaded')
  assert.equal(policy.cooldownUntil, 16_000)
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
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'x' },
    { type: 'text', text: 'keep' },
  ])
  const second = classifyUpstreamResult({
    status: 400,
    body: { error: { message: 'thinking.signature: Field required' } },
  }, { repaired: true })
  assert.equal(second.action, 'stop')
})

test('invalid thinking signature converts signed blocks to text', () => {
  const policy = classifyUpstreamResult({
    status: 400,
    body: { error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } },
  })
  assert.equal(policy.action, 'repair-and-retry')
  const body = repairAnthropicRequest({
    thinking: { type: 'adaptive' },
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'draft', signature: 'bad_sig' },
        { type: 'redacted_thinking', data: 'xx', signature: 'also_bad' },
        { type: 'text', text: 'visible' },
      ],
    }],
  }, policy)
  assert.equal(body.thinking, undefined)
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'draft' },
    { type: 'text', text: 'visible' },
  ])
})

test('fable 504 cools only the fable family', () => {
  const policy = classifyUpstreamResult({
    status: 504,
    body: { error: { message: 'timeout awaiting response headers' } },
  }, { model: 'claude-fable-5', now: 1000 })
  assert.equal(policy.scope, 'model')
  assert.equal(policy.model, 'fable')
  assert.equal(policy.reason, 'fable_timeout')
})

test('7d_oi 429 cools fable family not the account', () => {
  const now = 1_700_000_000_000
  const policy = classifyUpstreamResult({
    status: 429,
    body: { error: { type: 'rate_limit_error', message: 'limited' } },
    headers: {
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-reset': String(now + 90_000),
    },
  }, { model: 'claude-fable-5[1m]', now })
  assert.equal(policy.scope, 'model')
  assert.equal(policy.model, 'fable')
  assert.equal(policy.cooldownUntil, now + 90_000)
})

test('200 refusal with empty visible output is content_filter, not success', () => {
  const policy = classifyUpstreamResult({
    ok: true,
    status: 200,
    terminalState: 'verified',
    stopReason: 'refusal',
    body: {
      stop_reason: 'refusal',
      content: [{ type: 'thinking', thinking: 'hidden' }],
      usage: { input_tokens: 7582, output_tokens: 12 },
    },
  })
  assert.equal(policy.scope, 'request')
  assert.equal(policy.action, 'stop')
  assert.equal(policy.reason, 'content_filter_refusal')
})

test('assistant prefill 400 is repairable', () => {
  const policy = classifyUpstreamResult({
    status: 400,
    body: { error: { message: 'Conversation must end with a user message' } },
  })
  assert.equal(policy.action, 'repair-and-retry')
  assert.equal(policy.reason, 'prefill_repairable')
  const body = repairAnthropicRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  }, policy)
  assert.equal(body.messages.at(-1).role, 'user')
})

test('empty thinking history after repair gets a placeholder', () => {
  const body = repairAnthropicRequest({
    messages: [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }],
    }],
  }, { action: 'repair-and-retry' })
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: '(assistant content removed)' },
  ])
})
