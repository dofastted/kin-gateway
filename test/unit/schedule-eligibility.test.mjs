import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCredentialEligibility,
  credPanelUnavailable,
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

test('expired access without refresh is oauth_expired', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: false, expires_at: Math.floor(now / 1000) - 60 }),
    now,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_expired')
})

test('expired access with refresh stays eligible', () => {
  const now = Date.now()
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(now / 1000) - 60 }),
    now,
  })
  assert.equal(r.ok, true)
})

test('invalid_grant takes the slot out of the pool', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, refresh_error: 'invalid_grant' }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oauth_invalid_grant')
})

test('presence flags count as a credential without leftover tokens', () => {
  const r = evaluateCredentialEligibility({
    vm: vm({ has_access: true, has_refresh: true, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
  })
  assert.equal(r.ok, true)
})

test('panel treats expired+refresh as available', () => {
  assert.equal(credPanelUnavailable({ has_refresh: true }, Date.now() - 60_000), false)
  assert.equal(credPanelUnavailable({}, Date.now() - 60_000), true)
})
