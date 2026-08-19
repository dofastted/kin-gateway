import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace, listCaptures } from '../harness.mjs'
import { CRS_OFFICIAL_SYSTEM } from '../../src/lib/crs-persona.mjs'
import { uuidFromSeed } from '../../src/lib/forward-mode.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('default POST /v1/messages is CRS, not CLI', async () => {
  const gw = await startGateway({ mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr.via, 'crs-relay')
    assert.ok(!tr.argv)
    assert.equal(tr.system, CRS_OFFICIAL_SYSTEM)
    const diffs = listCaptures(gw)
    assert.ok(diffs.some((c) => c.via === 'crs-relay'))
    assert.ok(!diffs.some((c) => String(c.via || '').includes('cli')))
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

test('explicit x-kin-forward: cli still writes mock-claude argv', async () => {
  const gw = await startGateway({ mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.ok(tr.argv, 'CLI fallback must write argv trace')
    assert.ok(tr.argv.includes('--permission-mode'))
  } finally {
    await gw.stop()
  }
})
