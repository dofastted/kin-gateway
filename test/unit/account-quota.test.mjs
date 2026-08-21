import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-'))
}

test('ensure seeds account and is idempotent', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {}, accounts: [{ account_id: 'a1', vm_id: 'vm-1', email: 'a@x' }] })
  const acc = q.ensure({ account_id: 'a1' })
  assert.equal(acc.vm_id, 'vm-1')
  assert.equal(acc.email, 'a@x')
  assert.equal(acc.requests, 0)
  assert.equal(acc.unified['5h'].status, 'active')
})

test('ingestHeaders updates unified windows + counters + allocations', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestHeaders('a2', {
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-7d-utilization': '0.10',
    'anthropic-ratelimit-unified-5h-reset': '2026-08-18T12:00:00Z',
  }, { input_tokens: 100, output_tokens: 20 })
  const snap = q.snapshot()
  const acc = snap.accounts.find((a) => a.account_id === 'a2')
  assert.equal(acc.unified['5h'].utilization, 0.42)
  assert.equal(acc.unified['7d'].utilization, 0.1)
  assert.equal(acc.requests, 1)
  assert.equal(acc.tokens_in, 100)
  assert.equal(acc.tokens_out, 20)
  assert.equal(acc.recent_allocations.length, 1)
  assert.equal(acc.recent_allocations[0].util_5h, 0.42)
})

test('ingestHeaders accumulates cache tokens and mirrors the session window', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  const windows = []
  q.attachRuntimeRepo({ updateWindow: (accountId, patch) => windows.push({ accountId, ...patch }) })
  q.ingestHeaders('a-cache', {
    'anthropic-ratelimit-unified-5h-utilization': '0.2',
    'anthropic-ratelimit-unified-5h-reset': '2026-08-19T20:00:00Z',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  }, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 7,
  })
  q.ingestHeaders('a-cache', {}, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 2 })
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a-cache')
  assert.equal(acc.cache_read_tokens, 5)
  assert.equal(acc.cache_creation_tokens, 7)
  assert.equal(windows.length, 2)
  const end = Date.parse('2026-08-19T20:00:00Z')
  assert.equal(windows[0].sessionWindowEnd, end)
  assert.equal(windows[0].sessionWindowStart, end - 5 * 3600_000)
  assert.equal(windows[0].sessionWindowStatus, 'allowed')
})

test('canAccept blocks at safety ratio and records last_blocked', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } } })
  q.ingestHeaders('a3', { 'anthropic-ratelimit-unified-5h-utilization': '0.96' })
  const gate = q.canAccept('a3')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_safety')
  const acc = q.snapshot().accounts.find((a) => a.account_id === 'a3')
  assert.equal(acc.last_blocked.window, '5h')
})

test('cli rate_limit_event blocks via status', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ingestCliRateLimit('a4', { rateLimitType: 'five_hour', status: 'rejected', resetsAt: 1893456000 })
  const gate = q.canAccept('a4')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'quota_5h_cli')
})

test('state persists across re-open (same dataDir)', () => {
  const dir = tmpDir()
  const q1 = new AccountQuota({ dataDir: dir, config: {} })
  q1.ingestHeaders('a5', { 'anthropic-ratelimit-unified-7d-utilization': '0.5' }, { input_tokens: 7, output_tokens: 3 })

  const q2 = new AccountQuota({ dataDir: dir, config: {} })
  const acc = q2.snapshot().accounts.find((a) => a.account_id === 'a5')
  assert.ok(acc)
  assert.equal(acc.unified['7d'].utilization, 0.5)
  assert.equal(acc.tokens_in, 7)
  assert.equal(acc.requests, 1)
  assert.equal(acc.recent_allocations.length, 1)
})

test('allocations trimmed to 50 per account', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  for (let i = 0; i < 60; i++) {
    q.ingestHeaders('a6', { 'anthropic-ratelimit-unified-5h-utilization': String(i / 100) })
  }
  assert.equal(q.repo.allocationCount('a6'), 50)
  const recent = q.repo.recentAllocations('a6', 5)
  assert.equal(recent.length, 5)
  assert.equal(recent[4].util_5h, 0.59)
})

test('max_concurrency 0 blocks instead of treating as unlimited', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { concurrency: { default_max_per_account: 20 } } })
  q.ensure({ account_id: 'zero', max_concurrency: 0 })
  q.setMaxConcurrency('zero', 0)
  const gate = q.canAccept('zero')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'concurrency_limit')
  assert.equal(gate.detail.max, 0)
})

test('rebindToVm moves the UUID row onto the new slot', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: {} })
  q.ensure({ account_id: '1c5a7a73', vm_id: 'vm-02', email: 'old@x' })
  q.rebindToVm('1c5a7a73', 'vm-04', { email: 'new@x' })
  const acc = q.snapshot().accounts.find((a) => a.account_id === '1c5a7a73')
  assert.equal(acc.vm_id, 'vm-04')
  assert.equal(acc.email, 'new@x')
})

test('concurrency inflight gate stays in memory', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { concurrency: { default_max_per_account: 1 } } })
  q.ensure({ account_id: 'a7' })
  q.acquire('a7')
  const gate = q.canAccept('a7')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'concurrency_limit')
  q.release('a7')
  assert.equal(q.canAccept('a7').ok, true)
})

test('ingestOAuthUsage stores 5h/7d and isolated fable limit', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } } })
  q.ingestOAuthUsage('acc-fable', {
    ok: true,
    five_hour: { utilization: 0.2, resets_at: '2026-08-18T20:00:00Z', status: 'allowed' },
    seven_day: { utilization: 0.4, resets_at: '2026-08-24T00:00:00Z', status: 'allowed' },
    seven_day_sonnet: { utilization: 0.1, resets_at: '2026-08-24T00:00:00Z', status: 'allowed' },
    extra_usage: { is_enabled: false, status: 'rejected' },
    fable: { ok: false, limited: true, banned: false, status: 429, model: 'claude-fable-5', reset_at: '2026-08-25T00:00:00Z' },
    seven_day_oi: { utilization: 0.54, resets_at: '2026-08-25T00:00:00Z', status: 'allowed' },
    probed_at: '2026-08-18T12:00:00Z',
  })
  const acc = q.repo.get('acc-fable')
  assert.equal(acc.unified['5h'].utilization, 0.2)
  assert.equal(acc.unified['7d'].utilization, 0.4)
  assert.equal(acc.unified.fable.limited, false)
  assert.equal(acc.unified.fable.utilization, 0.54)
  assert.equal(acc.unified['7d_oi'].utilization, 0.54)
  assert.equal(acc.unified['7d_oi'].status, 'allowed')
  assert.equal(acc.unified.seven_day_sonnet.utilization, 0.1)
  const gate = q.canAccept('acc-fable')
  assert.equal(gate.ok, true, 'fable weekly limit must not block the whole account')
})

test('7d_oi window is Fable-only and does not block the account', () => {
  const q = new AccountQuota({ dataDir: tmpDir(), config: { quota: { safety_ratio: 0.95, block_on_5h: true, block_on_7d: true } } })
  q.ingestHeaders('acc-oi', {
    'anthropic-ratelimit-unified-7d_oi-utilization': '1',
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-7d_oi-reset': '2026-08-25T00:00:00Z',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  })
  assert.equal(q.canAccept('acc-oi').ok, true)
  assert.equal(q.fableWindowLimited('acc-oi'), true)
  assert.equal(q.fableWindowResetAt('acc-oi'), Date.parse('2026-08-25T00:00:00Z'))
})
