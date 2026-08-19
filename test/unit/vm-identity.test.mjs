import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMetadataUserId, loadVmIdentity } from '../../src/lib/vm-identity.mjs'
import { applyCrsIdentityReplace } from '../../src/lib/identity-rewrite.mjs'

test('metadata.user_id is official JSON for current CLI', () => {
  const s = formatMetadataUserId({
    deviceId: 'a'.repeat(64),
    accountUuid: 'acc',
    sessionId: 'sess',
  })
  const o = JSON.parse(s)
  assert.equal(o.device_id.length, 64)
  assert.equal(o.account_uuid, 'acc')
  assert.equal(o.session_id, 'sess')
})

test('identity replace overwrites client metadata with slot identity', () => {
  const id = {
    deviceId: 'd'.repeat(64),
    accountUuid: 'u',
    metadataUserId: formatMetadataUserId({ deviceId: 'd'.repeat(64), accountUuid: 'u', sessionId: 's' }),
  }
  const out = applyCrsIdentityReplace({ model: 'x', metadata: { user_id: 'windows-client' } }, id)
  assert.notEqual(out.metadata.user_id, 'windows-client')
  assert.ok(String(out.metadata.user_id).includes('account_uuid'))
})

test('loadVmIdentity builds settings from seed + timezone', () => {
  const id = loadVmIdentity({
    vmId: 'vm-1',
    homeDir: '/tmp/does-not-exist-kin',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    oauth: { account_uuid: 'acc-1', org_uuid: 'org-1', email: 'a@b.c' },
    seedPolicy: { theme: 'dark', telemetry_disabled: true },
    vm: { fingerprint: { device_id: 'dev', session_id: 'sess-1' }, claude_code_version: '2.1.233' },
  })
  assert.equal(id.settings.theme, 'dark')
  assert.equal(id.settings.env.TZ, 'America/Los_Angeles')
  assert.equal(id.settings.env.DISABLE_TELEMETRY, '1')
  assert.equal(id.sessionId, 'sess-1')
  assert.equal(id.accountUuid, 'acc-1')
  assert.match(id.userAgent, /claude-cli\/2\.1\.233/)
})


test('identity replace uses the slot device_id', () => {
  const id = {
    deviceId: 'd'.repeat(64),
    accountUuid: 'u',
    sessionId: 's',
    metadataUserId: formatMetadataUserId({ deviceId: 'd'.repeat(64), accountUuid: 'u', sessionId: 's' }),
  }
  const inbound = {
    metadata: { user_id: JSON.stringify({ device_id: 'caller-dev', account_uuid: '', session_id: 'caller-sess' }) },
  }
  const out = applyCrsIdentityReplace({ model: 'x', metadata: inbound.metadata }, id, inbound)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, 'd'.repeat(64))
  assert.equal(uid.account_uuid, 'u')
})
