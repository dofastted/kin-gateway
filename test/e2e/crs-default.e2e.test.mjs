import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'
import { CRS_OFFICIAL_SYSTEM } from '../../src/lib/crs-persona.mjs'
import { uuidFromSeed } from '../../src/lib/identity-rewrite.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('default POST /v1/messages uses Go worker pool, not CLI', async () => {
  const gw = await startGateway({ mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr.via, 'go-worker')
    assert.ok(!tr.argv)
    assert.equal(tr.system, CRS_OFFICIAL_SYSTEM)
  } finally {
    await gw.stop()
  }
})

test('CRS identity: VM device, hashed caller session, OAuth account', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 8,
        metadata: { user_id: JSON.stringify({ device_id: 'caller-dev', account_uuid: '', session_id: 'caller-sess' }) },
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    const uid = JSON.parse(tr.body.metadata.user_id)
    assert.notEqual(uid.device_id, 'caller-dev')
    assert.equal(uid.account_uuid, 'acct-seed')
    assert.equal(uid.session_id, uuidFromSeed('acct-seed::caller-sess'))
  } finally {
    await gw.stop()
  }
})

test('explicit x-kin-forward: cli is ignored by Go-only inference path', async () => {
  const gw = await startGateway({ mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr.via, 'go-worker')
    assert.equal(tr.argv, undefined)
  } finally {
    await gw.stop()
  }
})
