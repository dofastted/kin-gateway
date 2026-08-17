import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('POST /v1/chat/completions non-stream', async () => {
  const gw = await startGateway({ mockText: 'hello-chat' })
  try {
    const r = await api(gw, 'POST', '/v1/chat/completions', {
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.ok(r.json.choices?.[0]?.message?.content || r.json.choices)
    const text = JSON.stringify(r.json)
    assert.match(text, /hello-chat/)
  } finally {
    await gw.stop()
  }
})

test('POST /v1/chat/completions stream ends with [DONE]', async () => {
  const gw = await startGateway({ mockText: 'chunk' })
  try {
    const res = await fetch(gw.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /data:/)
    assert.match(body, /\[DONE\]/)
  } finally {
    await gw.stop()
  }
})
