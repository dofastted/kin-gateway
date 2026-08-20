import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner, SERVER_OVERLOAD_MESSAGE } from '../../src/lib/pool/failover-runner.mjs'

class Scheduler {
  constructor(candidates) {
    this.candidates = candidates
    this.cooldowns = []
    this.successes = []
    this.selectCalls = 0
  }

  async selectAndReserve({ excluded }) {
    this.selectCalls++
    const candidate = this.candidates.find((item) => (
      !excluded.has(item.accountId) && !excluded.has(item.vmId)
    ))
    if (!candidate) return { ok: false, reason: 'no_eligible_accounts' }
    return { ...candidate, ok: true, release() {} }
  }

  markCooldown(candidate, update) {
    this.cooldowns.push({ candidate, update })
  }

  markSuccess(candidate) {
    this.successes.push(candidate)
  }
}

class Attempts {
  items = []
  begin(item) { this.items.push({ ...item, state: 'started' }) }
  complete(requestId, attemptNo, result) {
    const item = this.items.find((entry) => entry.requestId === requestId && entry.attemptNo === attemptNo)
    Object.assign(item, result, { state: 'completed' })
  }
}

function candidate(number) {
  return {
    vmId: `vm-0${number}`,
    accountId: `account-${number}`,
    selectionReason: number === 1 ? 'sticky' : 'weighted-round-robin',
    waitMs: 0,
  }
}

function success(text = 'ok') {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

test('account1 quota exhausted rotates to account2 and commits final sticky', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const attempts = new Attempts()
  const bindings = []
  const runner = new FailoverRunner({
    scheduler,
    attemptsRepo: attempts,
    stickyRouter: { bind: (key, value) => bindings.push({ key, value }) },
  })
  const seen = []
  const result = await runner.run({
    requestId: 'req-1',
    canonicalBody: { model: 'claude-opus-test', metadata: { user_id: 'caller' } },
    model: 'claude-opus-test',
    stickyKey: 'conversation-1',
    applyAttempt: (body, selected) => {
      body.metadata.user_id = selected.accountId
      return body
    },
    callAttempt: ({ candidate: selected, body }) => {
      seen.push({ accountId: selected.accountId, userId: body.metadata.user_id })
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 429,
          terminalState: 'rejected',
          body: { error: { type: 'rate_limit_error', message: '5h exhausted' } },
          headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
        }
      }
      return success()
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-2')
  assert.equal(result.attemptCount, 2)
  assert.deepEqual(seen, [
    { accountId: 'account-1', userId: 'account-1' },
    { accountId: 'account-2', userId: 'account-2' },
  ])
  assert.equal(scheduler.cooldowns.length, 1)
  assert.equal(scheduler.cooldowns[0].candidate.accountId, 'account-1')
  assert.deepEqual(bindings, [{
    key: 'conversation-1',
    value: { accountId: 'account-2', vmId: 'vm-02' },
  }])
  assert.equal(attempts.items.length, 2)
  assert.equal(attempts.items[1].terminalState, 'verified')
})

test('request-scoped entitlement error does not walk the pool', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-2',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => ({
      ok: false,
      status: 429,
      terminalState: 'rejected',
      body: { error: { message: 'Usage credits are required for fast mode' } },
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
  assert.equal(scheduler.cooldowns.length, 0)
})

test('committed realtime stream failure never switches accounts', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-3',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    stream: true,
    callAttempt: ({ onCommit }) => {
      onCommit()
      return {
        ok: false,
        status: 200,
        committed: true,
        terminalState: 'incomplete',
        body: { error: { message: 'stream closed' } },
      }
    },
  })
  assert.equal(result.finalState, 'incomplete')
  assert.equal(result.attemptCount, 1)
  assert.equal(scheduler.selectCalls, 1)
})

test('cloudflare 403 does not trigger SOCKS disconnect', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onProxyFailure: (vmId, reason) => failures.push({ vmId, reason }),
  })
  const result = await runner.run({
    requestId: 'req-cf',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 403,
          terminalState: 'rejected',
          body: { error: { message: '<html>cloudflare</html>' } },
        }
      }
      return success()
    },
  })
    assert.equal(failures.length, 0)
})

test('proxy transport error notifies onProxyFailure then rotates', async () => {
  const scheduler = new Scheduler([candidate(1), candidate(2)])
  const failures = []
  const runner = new FailoverRunner({
    scheduler,
    onProxyFailure: (vmId, reason) => failures.push({ vmId, reason }),
  })
  const result = await runner.run({
    requestId: 'req-proxy',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: ({ candidate: selected }) => {
      if (selected.accountId === 'account-1') {
        return {
          ok: false,
          status: 0,
          transportError: true,
          terminalState: 'transport_error',
          body: { error: { code: 'worker_transport_error', message: 'SOCKS proxy dial failed' } },
        }
      }
      return success()
    },
  })
    assert.ok(failures.length >= 1)
    assert.equal(failures[0].vmId, 'vm-01')
    assert.equal(failures[0].reason, 'proxy_transport_failure')
})

test('signature error is repaired once on the same account', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-4',
    canonicalBody: {
      model: 'claude-opus-test',
      thinking: { type: 'enabled' },
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'keep' }] }],
    },
    model: 'claude-opus-test',
    callAttempt: ({ body }) => {
      calls++
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          body: { error: { message: 'thinking.signature: Field required' } },
        }
      }
      assert.equal(body.thinking, undefined)
      assert.deepEqual(body.messages[0].content, [
        { type: 'text', text: 'x' },
        { type: 'text', text: 'keep' },
      ])
      return success('repaired')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.attemptCount, 2)
  assert.equal(calls, 2)
})

test('provider overload waits and retries the same account', async () => {
  const scheduler = new Scheduler([candidate(1)])
  const runner = new FailoverRunner({ scheduler })
  let calls = 0
  const result = await runner.run({
    requestId: 'req-5',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => {
      calls++
      if (calls === 1) {
        return {
          ok: false,
          status: 502,
          terminalState: 'error',
          body: { error: { message: 'timeout awaiting response headers' } },
        }
      }
      return success('after-wait')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accountId, 'account-1')
  assert.equal(result.attemptCount, 2)
  assert.equal(calls, 2)
  assert.equal(scheduler.selectCalls, 2)
  assert.equal(scheduler.cooldowns.length, 1)
})

test('pool exhaustion returns the unified overload message', async () => {
  const scheduler = new Scheduler([])
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'req-6',
    canonicalBody: { model: 'claude-opus-test' },
    model: 'claude-opus-test',
    callAttempt: () => success(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.body.error.message, SERVER_OVERLOAD_MESSAGE)
  assert.equal(result.body.error.code, 'server_overloaded')
})
