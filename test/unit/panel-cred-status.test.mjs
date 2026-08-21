import test from 'node:test'
import assert from 'node:assert/strict'
import { credStatusFromQuota } from '../../src/lib/admin/panel-api.mjs'

test('5h 87% allowed is caution, not unavailable', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.87,
    utilization_7d: 0.18,
    status_5h: 'allowed',
    status_7d: 'allowed',
  }, Date.now() + 3600_000, { worker_credential: { has_access: true, needs_refresh: false } })
  assert.equal(st.key, 'caution')
  assert.equal(st.text, '5h 警告')
})

test('fable banned is revoked, not a quota warning', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
    fable: { banned: true },
  })
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '被吊销')
})

test('5h rejected is limited, not unavailable', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 1,
    status_5h: 'rejected',
  })
  assert.equal(st.key, 'warn')
  assert.equal(st.text, '5h 限制')
})

test('weekly split regular half full is 普通限制', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    utilization_7d: 0.5,
    status_5h: 'allowed',
    status_7d: 'allowed',
    weekly_split: { enabled: true, mode: 'fable_only' },
  })
  assert.equal(st.key, 'warn')
  assert.equal(st.text, '普通限制')
})

test('weekly split fable half full is Fable 限制', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    utilization_7d: 0.2,
    status_5h: 'allowed',
    status_7d: 'allowed',
    weekly_split: { enabled: true, mode: 'regular_only' },
  })
  assert.equal(st.key, 'warn')
  assert.equal(st.text, 'Fable 限制')
})

test('weekly split off does not use mode', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
    weekly_split: { enabled: false, mode: 'fable_only' },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('expired TTL is unavailable even if worker still reports has_access', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() - 60_000, { worker_credential: { has_access: true, needs_refresh: false } })
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '不可用')
})

test('oauth_ disabled reason is unavailable', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() + 3600_000, { schedulable: false, schedule_disabled_reason: 'oauth_no_refresh' })
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '不可用')
})
