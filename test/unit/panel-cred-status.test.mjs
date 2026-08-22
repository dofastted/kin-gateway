import test from 'node:test'
import assert from 'node:assert/strict'
import { credStatusFromQuota, inferClaudeTier, normalizePanelExpiresAt } from '../../src/lib/admin/panel-api.mjs'

test('panel expires_at is always milliseconds', () => {
  const sec = 1787413581
  assert.equal(normalizePanelExpiresAt(sec), sec * 1000)
  assert.equal(normalizePanelExpiresAt(sec, sec * 1000), sec * 1000)
  assert.equal(normalizePanelExpiresAt(null, sec * 1000), sec * 1000)
  assert.equal(normalizePanelExpiresAt(null, null), null)
})

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

test('fable banned without revoke text does not kill a live slot ticket', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0,
    status_5h: 'allowed',
    fable: { banned: true, status: 401, error: 'Error' },
  }, Date.now() + 8 * 3600_000, {
    has_token: true,
    worker_credential: { has_access: true, has_refresh: true, needs_refresh: false, expires_at: Date.now() + 8 * 3600_000 },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('messages 401 revoked is unavailable even if TTL is still future', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0,
    status_5h: 'allowed',
    last_probe: { ok: false, at: new Date().toISOString(), error: 'OAuth access token has been revoked.' },
  }, Date.now() + 8 * 3600_000, {
    has_token: true,
    last_probe: { ok: false, at: new Date().toISOString(), error: 'OAuth access token has been revoked.' },
    worker_credential: { has_access: true, has_refresh: true, needs_refresh: false, expires_at: Date.now() + 8 * 3600_000 },
  })
  assert.equal(st.key, 'bad')
  assert.equal(st.text, '不可用')
})

test('stale last_probe revoke after a newer refresh is available', () => {
  const now = Date.now()
  const st = credStatusFromQuota(true, {
    utilization_5h: 0,
    status_5h: 'allowed',
    last_probe: { ok: false, at: new Date(now - 20 * 60_000).toISOString(), error: 'OAuth access token has been revoked.' },
    fable: { banned: true, status: 401, error: 'OAuth access token has been revoked.', probed_at: new Date(now - 20 * 60_000).toISOString() },
  }, now + 8 * 3600_000, {
    has_token: true,
    has_refresh: true,
    refreshed_at: new Date(now - 5 * 60_000).toISOString(),
    last_probe: { ok: false, at: new Date(now - 20 * 60_000).toISOString(), error: 'OAuth access token has been revoked.' },
    worker_credential: { has_access: true, has_refresh: true, needs_refresh: false, expires_at: now + 8 * 3600_000 },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
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

test('weekly split fable half full does not mark the account as 限制', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    utilization_7d: 0.2,
    status_5h: 'allowed',
    status_7d: 'allowed',
    weekly_split: { enabled: true, mode: 'regular_only' },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('fable 7d_oi rejected is still 可用 for Pro / Fable-unavailable', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0,
    utilization_7d: 0,
    status_5h: 'allowed',
    status_7d: 'allowed',
    utilization_7d_oi: 1,
    status_7d_oi: 'rejected',
    fable: { ok: false, limited: true, banned: false, status: 429 },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('fable 403 permission is Pro, not 被吊销', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
    fable: { banned: true, plan_denied: true, status: 403, error: 'permission_error' },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('fable cooldown does not mark the account as 限制', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() + 3600_000, { fable_cooldown_until: Date.now() + 60_000 })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
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

test('stale worker expiry is ignored when vm.json TTL is newer and refresh exists', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0,
    status_5h: 'allowed',
  }, Date.now() + 8 * 3600_000, {
    has_refresh: true,
    worker_credential: {
      has_access: true,
      has_refresh: true,
      needs_refresh: true,
      expires_at: Date.now() - 3600_000,
    },
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('expired TTL with refresh remains available for worker refresh', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() - 60_000, { has_refresh: true, worker_credential: { has_access: false, has_refresh: true } })
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

test('operator schedule switch does not mark the account unavailable', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() + 3600_000, { schedulable: false, schedule_disabled_reason: 'disabled' })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('leftover oauth_cleared with a live credential is available', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() + 3600_000, {
    schedulable: false,
    schedule_disabled_reason: 'oauth_cleared',
    has_refresh: true,
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('leftover oauth_no_refresh with a live credential is available', () => {
  const st = credStatusFromQuota(true, {
    utilization_5h: 0.1,
    status_5h: 'allowed',
  }, Date.now() + 3600_000, {
    schedulable: false,
    schedule_disabled_reason: 'oauth_no_refresh',
    has_refresh: true,
  })
  assert.equal(st.key, 'ok')
  assert.equal(st.text, '可用')
})

test('Claude tier: no token is none, plan denied is Pro, Fable window is Max', () => {
  assert.equal(inferClaudeTier({}).key, 'none')
  assert.equal(inferClaudeTier({ has_token: true }, { fable: { plan_denied: true, status: 403 } }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true, utilization_7d_oi: 0.21 }).key, 'max')
  assert.equal(inferClaudeTier({ has_token: true, fable: { ok: true } }).key, 'max')
  assert.equal(inferClaudeTier({ has_token: true }, { fable: { plan_denied: true, status: 401, error: 'plan_denied' } }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true }, { fable: { ok: false, status: 429, error: 'Error' } }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true, utilization_7d_oi: 1 }, {
    fable: { ok: false, status: 429, error: 'Error' },
    utilization_7d_oi: 1,
    status_7d_oi: 'rejected',
  }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true, utilization_7d_oi: 0.44, reset_7d_oi: '2026-08-24T00:00:00Z' }, {
    fable: { ok: false, status: 502 },
    utilization_7d_oi: 0.44,
    reset_7d_oi: '2026-08-24T00:00:00Z',
  }).key, 'max')
  assert.equal(inferClaudeTier({ has_token: true, account_tier: 'pro' }).key, 'pro')
  assert.equal(inferClaudeTier({ has_token: true }).key, 'unknown')
})
