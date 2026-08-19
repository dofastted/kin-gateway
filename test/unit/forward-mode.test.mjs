import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveForwardMode,
  applyForwardReplace,
  applyCrsIdentityReplace,
  shouldFallbackToCli,
  uuidFromSeed,
} from '../../src/lib/forward-mode.mjs'

test('default forward is relay (CRS HTTP)', () => {
  assert.equal(resolveForwardMode({}, {}), 'relay')
})

test('x-kin-forward selects cli fallback / relay aliases', () => {
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'cli' } }, {}), 'cli')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'cliproxy' } }, {}), 'cli')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'crs' } }, {}), 'relay')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'sub2api' } }, {}), 'relay')
})

test('relay replaces only device_id with VM; session is CRS-hashed caller session', () => {
  const body = {
    settings: { theme: 'light' },
    metadata: {
      user_id: JSON.stringify({ device_id: 'win-dev', account_uuid: 'win-acc', session_id: 'win-sess' }),
      machine_id: 'pc',
    },
  }
  const id = {
    vmId: 'vm-01',
    deviceId: 'vm-dev',
    accountUuid: 'vm-acc',
    sessionId: 'vm-sess',
    metadataUserId: JSON.stringify({ device_id: 'vm-dev', account_uuid: 'vm-acc', session_id: 'vm-sess' }),
  }
  const out = applyForwardReplace('relay', body, id, body)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, 'vm-dev')
  assert.equal(uid.account_uuid, 'vm-acc')
  assert.notEqual(uid.session_id, 'win-sess')
  assert.notEqual(uid.session_id, 'vm-sess')
  assert.equal(uid.session_id, uuidFromSeed('vm-acc::win-sess'))
  assert.equal(out.settings, undefined)
  assert.equal(out.metadata.machine_id, undefined)
})

test('cli still full-replaces identity to the VM', () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({ device_id: 'win-dev', account_uuid: 'win-acc', session_id: 'win-sess' }),
    },
  }
  const id = {
    sessionId: 'vm-sess',
    metadataUserId: JSON.stringify({ device_id: 'vm-dev', account_uuid: 'vm-acc', session_id: 'vm-sess' }),
  }
  const out = applyForwardReplace('cli', body, id)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, 'vm-dev')
  assert.equal(uid.account_uuid, 'vm-acc')
  assert.equal(uid.session_id, 'vm-sess')
})

test('CRS replace is stable for the same inbound session', () => {
  const inbound = { metadata: { user_id: JSON.stringify({ device_id: 'd1', session_id: 's1' }) } }
  const id = { accountUuid: 'acc', deviceId: 'vm', vmId: 'vm-01' }
  const a = applyCrsIdentityReplace({ model: 'x' }, id, inbound)
  const b = applyCrsIdentityReplace({ model: 'x' }, id, inbound)
  assert.deepEqual(JSON.parse(a.metadata.user_id), JSON.parse(b.metadata.user_id))
})

test('do not fall back to CLI on 401/403', () => {
  assert.equal(shouldFallbackToCli({ ok: false, status: 401 }), false)
  assert.equal(shouldFallbackToCli({ ok: false, status: 403 }), false)
  assert.equal(shouldFallbackToCli({ ok: false, status: 529 }), true)
  assert.equal(shouldFallbackToCli({ ok: false, transportError: true, status: 0 }), true)
  assert.equal(shouldFallbackToCli({ ok: true, status: 200 }), false)
})
