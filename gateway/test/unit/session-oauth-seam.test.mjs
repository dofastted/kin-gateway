import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionKeyToOAuth } from '../../../session-to-oauth.mjs'

test('KIN_FAKE_SESSION_OAUTH returns deterministic creds without network', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const cred = await sessionKeyToOAuth('sk-ant-sid-test-aaaaaaaa')
  assert.equal(cred.source, 'KIN_FAKE_SESSION_OAUTH')
  assert.equal(cred.email, 'fake-oauth@kin.test')
  assert.match(cred.access_token, /^sk-ant-oat01-FAKE/)
  assert.ok(cred.expires_at > Math.floor(Date.now() / 1000))
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('fake branch still rejects non-sid keys', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  await assert.rejects(() => sessionKeyToOAuth('not-a-sid'), /sk-ant-sid/)
  delete process.env.KIN_FAKE_SESSION_OAUTH
})
