import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('POST /v1/responses non-stream', async () => {
  const gw = await startGateway({ mockText: 'hello-resp' })
  try {
    const r = await api(gw, 'POST', '/v1/responses', {
      body: {
        model: MODEL,
        input: 'hi',
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.match(JSON.stringify(r.json), /hello-resp/)
  } finally {
    await gw.stop()
  }
})

test('POST /v1/responses stream includes [DONE]', async () => {
  const gw = await startGateway({ mockText: 'rchunk' })
  try {
    const res = await fetch(gw.baseUrl + '/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, stream: true, input: 'hi' }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /data:/)
    assert.match(body, /\[DONE\]/)
  } finally {
    await gw.stop()
  }
})
