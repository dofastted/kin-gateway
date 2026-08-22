import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('POST /v1/responses non-stream shape: object + output_text + usage', async () => {
  const gw = await startGateway({ mockText: 'hello-resp' })
  try {
    const r = await api(gw, 'POST', '/v1/responses', {
      body: { model: MODEL, input: 'hi' },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.object, 'response')
    assert.equal(r.json.status, 'completed')
    assert.equal(r.json.output_text, 'hello-resp')
    const msg = (r.json.output || []).find((o) => o.type === 'message')
    assert.ok(msg)
    assert.equal(msg.content[0].type, 'output_text')
    assert.equal(msg.content[0].text, 'hello-resp')
    assert.equal(typeof r.json.usage.input_tokens, 'number')
    assert.equal(typeof r.json.usage.output_tokens, 'number')
    assert.equal(r.json.usage.total_tokens, r.json.usage.input_tokens + r.json.usage.output_tokens)
    const tr = readTrace(gw)
    assert.equal(tr.body.stream, true)
    assert.notEqual(r.headers.get('content-type'), 'text/event-stream')
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

test('POST /v1/responses tools → function_call in output', async () => {
  const gw = await startGateway({ scenario: 'tool_use' })
  try {
    const r = await api(gw, 'POST', '/v1/responses', {
      body: {
        model: MODEL,
        input: 'read /tmp/x',
        tools: [{
          type: 'function',
          name: 'read_file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const fc = (r.json.output || []).find((o) => o.type === 'function_call')
    assert.ok(fc, JSON.stringify(r.json.output))
    assert.equal(fc.name, 'read_file')
  } finally {
    await gw.stop()
  }
})
