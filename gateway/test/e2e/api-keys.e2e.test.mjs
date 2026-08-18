import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('panel creates managed key; key can call /v1/messages', async () => {
  const gw = await startGateway({ mockText: 'hello-key' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'e2e', max_concurrency: 2, quota_requests: 5, rpm: 60 },
    })
    assert.equal(created.status, 201, created.text)
    assert.ok(created.json.item?.key?.startsWith('sk-kin-'))
    const key = created.json.item.key

    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    assert.match(JSON.stringify(r.json), /hello-key/)

    const list = await api(gw, 'GET', '/api/panel/api-keys')
    assert.equal(list.status, 200)
    assert.ok(list.json.keys.some((k) => k.name === 'e2e'))
    assert.ok(list.json.keys[0].key.includes('…'))
  } finally {
    await gw.stop()
  }
})

test('quota_requests=1 rejects second call', async () => {
  const gw = await startGateway({ mockText: 'once' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'quota1', max_concurrency: 2, quota_requests: 1, rpm: 0 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item.key

    const a = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '1' }] },
    })
    assert.equal(a.status, 200, a.text)

    const b = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '2' }] },
    })
    assert.equal(b.status, 429, b.text)
    assert.match(JSON.stringify(b.json), /quota/i)
  } finally {
    await gw.stop()
  }
})

test('disabled key returns 403', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'off' },
    })
    const id = created.json.item.id
    const key = created.json.item.key
    await api(gw, 'PATCH', `/api/panel/api-keys/${id}`, { body: { status: 'disabled' } })
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 403, r.text)
  } finally {
    await gw.stop()
  }
})

test('master key still works; delete key invalidates', async () => {
  const gw = await startGateway({ mockText: 'master' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'tmp' } })
    const id = created.json.item.id
    const key = created.json.item.key
    const del = await api(gw, 'DELETE', `/api/panel/api-keys/${id}`)
    assert.equal(del.status, 200)
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 401, r.text)

    // master (harness apiKey) still works
    const m = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(m.status, 200, m.text)
  } finally {
    await gw.stop()
  }
})
