import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCredentialEligibility,
  evaluateProxySync,
  credPanelUnavailable,
  shouldMarkMissingRefresh,
  isCredentialRuntimeBlocked,
} from '../../src/lib/pool/schedule-eligibility.mjs'

function vm(claude = {}) {
  return {
    id: 'vm-01',
    status: 'running',
    schedulable: true,
    proxy_cli_enabled: true,
    proxy: { url: 'socks5h://127.0.0.1:1080' },
    claude,
  }
}
test('retryable refresh error does not become permanent credential failure', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Date.now() - 60_000 }),
    workerStatus: {
      ok: false,
      last_error_class: 'retryable',
      last_error: 'OAuth refresh failed (timeout)',
      credential: { has_access: true, has_refresh: true, needs_refresh: true, expires_at: Date.now() - 60_000 },
    },
  })
  assert.equal(r.reason, 'refresh_pending')
})

test('expired access without refresh is oauth_expired', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: false, expires_at: Math.floor(now / 1000) - 60 }),
    now,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_expired')
})

test('revoked access is oauth_revoked even when TTL is future', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({
      has_access: true,
      has_refresh: true,
      expires_at: Math.floor(now / 1000) + 3600,
      refresh_error: 'OAuth access token has been revoked.',
    }),
    now,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_revoked')
})

test('expired access with refresh remains schedulable while worker can refresh', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(now / 1000) - 60 }),
    workerStatus: {
      ok: true,
      credential: { has_access: true, has_refresh: true, needs_refresh: true, expires_at: now - 60_000 },
    },
    now,
  })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'refresh_pending')
})

test('invalid_grant takes the slot out of the pool', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, refresh_error: 'invalid_grant' }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_invalid_grant')
})

test('leftover worker last_error does not eject a live worker', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, refresh_error: 'invalid_grant' }),
    workerStatus: {
      ok: true,
      error: 'OAuth refresh failed (invalid_grant): Refresh token not found or invalid',
      credential: {
        has_access: true,
        has_refresh: true,
        needs_refresh: false,
        expires_at: Date.now() + 3600_000,
      },
    },
  })
  assert.equal(r.ok, true)
})

test('stale access 401 cooldown does not block a live grant', () => {
  const now = Date.now()
  assert.equal(isCredentialRuntimeBlocked({
    status: 'cooldown',
    cooldown_until: now + 600_000,
    cooldown_reason: 'authentication_failed_after_refresh',
  }, now), false)
  assert.equal(isCredentialRuntimeBlocked({
    status: 'cooldown',
    cooldown_until: now + 600_000,
    cooldown_reason: 'oauth_invalid_grant',
  }, now), true)
})

test('presence flags count as a credential without leftover tokens', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
  })
  assert.equal(r.ok, true)
})

test('panel treats expired access with refresh as refreshable', () => {
  assert.equal(credPanelUnavailable({ has_refresh: true }, Date.now() - 60_000), false)
  assert.equal(credPanelUnavailable({}, Date.now() - 60_000), true)
})

test('operator schedule off is not credential-unavailable', () => {
  assert.equal(credPanelUnavailable({ schedulable: false, schedule_disabled_reason: 'disabled' }), false)
  assert.equal(credPanelUnavailable({ schedulable: false, schedule_disabled_reason: 'oauth_no_refresh' }), true)
})

test('leftover oauth_cleared with expired refreshable access remains available', () => {
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_cleared',
    has_refresh: true,
    has_token: true,
  }, Date.now() - 60_000), false)
})

test('leftover oauth_cleared is not unavailable after a live credential', () => {
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_cleared',
    has_refresh: true,
  }), false)
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_cleared',
    has_token: true,
  }), false)
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_cleared',
  }), true)
})

test('leftover oauth_no_refresh is not unavailable when refresh is present', () => {
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_no_refresh',
    has_refresh: true,
  }), false)
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_no_refresh',
    worker_credential: { has_access: true, has_refresh: true },
  }), false)
})

test('oauth_invalid_grant stays unavailable until access TTL is live', () => {
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_invalid_grant',
    has_refresh: true,
  }), true)
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_invalid_grant',
    has_refresh: true,
    worker_credential: { has_access: true, has_refresh: true, needs_refresh: true },
  }, Date.now() - 60_000), true)
  assert.equal(credPanelUnavailable({
    schedulable: false,
    schedule_disabled_reason: 'oauth_invalid_grant',
    has_token: true,
    worker_credential: { has_access: true, has_refresh: true, needs_refresh: false, expires_at: Date.now() + 3600_000 },
  }, Date.now() + 3600_000), false)
})

test('proxy desync is fail-closed before hop', () => {
  const v = vm()
  v.proxy = { host: '72.1.181.43', port: 5437, url: 'socks5://u:p@72.1.181.43:5437' }
  assert.equal(evaluateProxySync({ vm: v, workerProxyEndpoint: '72.1.181.43:5437' }).ok, true)
  const bad = evaluateProxySync({ vm: v, workerProxyEndpoint: '154.9.177.229:5509' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'proxy_desynced')
  assert.equal(evaluateProxySync({ vm: v }).ok, true)
})

test('shouldMarkMissingRefresh ignores stripped presence flags', () => {
  assert.equal(shouldMarkMissingRefresh({ claude: { has_refresh: true } }), false)
  assert.equal(shouldMarkMissingRefresh({ claude: { refresh_token: 'rt' } }), false)
  assert.equal(shouldMarkMissingRefresh({ claude: { has_access: true } }), true)
  assert.equal(shouldMarkMissingRefresh({ claude: {} }), true)
})
