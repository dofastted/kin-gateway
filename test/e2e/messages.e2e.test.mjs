import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('POST /v1/messages non-stream returns mock text', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'ping' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.type, 'message')
    const text = (r.json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    assert.match(text, /pong/)
  } finally {
    await gw.stop()
  }
})

test('POST /v1/messages stream emits SSE event+data', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'pong' })
  try {
    const res = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /event:/)
    assert.match(body, /data:/)
    assert.match(body, /pong|text_delta|message_stop/)
  } finally {
    await gw.stop()
  }
})

test('tools → tool_use stop, name prefix stripped', async () => {
  const gw = await startGateway({ scenario: 'tool_use' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 64,
        tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [{ role: 'user', content: 'read /tmp/x' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.stop_reason, 'tool_use')
    const tu = (r.json.content || []).find((b) => b.type === 'tool_use')
    assert.ok(tu)
    assert.equal(tu.name, 'read_file')
    assert.doesNotMatch(tu.name, /mcp__/)
  } finally {
    await gw.stop()
  }
})

test('fail-closed hop argv: permission-mode default, no bypass, builtins denied', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    })
    const tr = readTrace(gw)
    assert.ok(tr, 'mock trace written')
    const a = tr.argv
    assert.ok(a.includes('--permission-mode'))
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'default')
    assert.ok(!a.includes('bypassPermissions'))
    const dis = a[a.indexOf('--disallowedTools') + 1] || ''
    assert.match(dis, /Bash/)
    assert.match(dis, /MultiEdit/)
    assert.ok(!a.includes('--allowedTools'))
  } finally {
    await gw.stop()
  }
})

test('thinking budget forwarded as MAX_THINKING_TOKENS; max_tokens dropped', async () => {
  const gw = await startGateway({ scenario: 'thinking' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 99,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 1234 },
        messages: [{ role: 'user', content: 'think' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr.env.MAX_THINKING_TOKENS, '1234')
  } finally {
    await gw.stop()
  }
})

test('multi-turn: mock stdin contains prior transcript + trailing user', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'second question' },
        ],
      },
    })
    const tr = readTrace(gw)
    assert.match(tr.stdin, /first answer|first question/)
    assert.match(tr.stdin, /second question/)
  } finally {
    await gw.stop()
  }
})

test('image block reaches mock stdin as Anthropic image', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        }],
      },
    })
    const tr = readTrace(gw)
    assert.match(tr.stdin, /"type":"image"/)
  } finally {
    await gw.stop()
  }
})

test('long system is truncated on argv', async () => {
  const gw = await startGateway({ scenario: 'text' })
  try {
    const sys = 'S'.repeat(30000)
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 8,
        system: sys,
        messages: [{ role: 'user', content: 'x' }],
      },
    })
    const tr = readTrace(gw)
    const i = tr.argv.indexOf('--append-system-prompt')
    assert.ok(i >= 0)
    assert.ok(tr.argv[i + 1].length <= 24000)
  } finally {
    await gw.stop()
  }
})
