import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, takeTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('POST /v1/chat/completions non-stream shape: choices + usage', async () => {
  const gw = await startGateway({ mockText: 'hello-chat' })
  try {
    const r = await api(gw, 'POST', '/v1/chat/completions', {
      body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.object, 'chat.completion')
    assert.ok(r.json.id)
    const ch = r.json.choices[0]
    assert.equal(ch.index, 0)
    assert.equal(ch.message.role, 'assistant')
    assert.equal(ch.message.content, 'hello-chat')
    assert.equal(ch.finish_reason, 'stop')
    assert.equal(typeof r.json.usage.prompt_tokens, 'number')
    assert.equal(typeof r.json.usage.completion_tokens, 'number')
    assert.equal(r.json.usage.total_tokens, r.json.usage.prompt_tokens + r.json.usage.completion_tokens)
  } finally {
    await gw.stop()
  }
})

test('POST /v1/chat/completions stream ends with [DONE] and chat.completion.chunk', async () => {
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
    assert.match(body, /chat\.completion\.chunk/)
  } finally {
    await gw.stop()
  }
})

test('OpenAI image_url data + http become Anthropic image in mock stdin', async () => {
  const gw = await startGateway({ mockText: 'saw' })
  try {
    const r = await api(gw, 'POST', '/v1/chat/completions', {
      body: {
        model: MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'see these' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = takeTrace(gw)
    assert.equal(tr.via, 'go-worker')
    const blob = JSON.stringify(tr.body)
    assert.match(blob, /"type":"image"/)
    assert.match(blob, /base64/)
    assert.match(blob, /https:\/\/example.com\/cat.png/)
  } finally {
    await gw.stop()
  }
})

test('OpenAI tools non-stream → tool_calls + finish_reason tool_calls', async () => {
  const gw = await startGateway({ scenario: 'tool_use' })
  try {
    const r = await api(gw, 'POST', '/v1/chat/completions', {
      body: {
        model: MODEL,
        tools: [{
          type: 'function',
          function: {
            name: 'read_file',
            description: 'read',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        }],
        messages: [{ role: 'user', content: 'read /tmp/x' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.choices[0].finish_reason, 'tool_calls')
    const tc = r.json.choices[0].message.tool_calls
    assert.ok(Array.isArray(tc) && tc.length)
    assert.equal(tc[0].function.name, 'read_file')
    assert.doesNotMatch(tc[0].function.name, /mcp__/)
    const args = JSON.parse(tc[0].function.arguments)
    assert.equal(args.path, '/tmp/x')
  } finally {
    await gw.stop()
  }
})

test('OpenAI tools stream emits tool_calls deltas', async () => {
  const gw = await startGateway({ scenario: 'tool_use' })
  try {
    const res = await fetch(gw.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        tools: [{
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        }],
        messages: [{ role: 'user', content: 'read /tmp/x' }],
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /tool_calls/)
    assert.match(body, /read_file/)
    assert.match(body, /\[DONE\]/)
  } finally {
    await gw.stop()
  }
})
