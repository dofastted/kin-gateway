/**
 * Long-session + multi-protocol: same x-session-id stays on the terminally
 * successful pool account while every HTTP attempt carries native history.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startGateway, api, takeTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'
const SID = 'conv-long-sim-001'

test('same x-session-id keeps native full history without CLI resume', async () => {
  const gw = await startGateway({ mockText: 'ack' })
  try {
    const h = { 'x-session-id': SID, 'x-kin-forward': 'cli' }

    const t1 = await api(gw, 'POST', '/v1/messages', {
      headers: h,
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'turn-one-hello' }] },
    })
    assert.equal(t1.status, 200, t1.text)
    const tr1 = takeTrace(gw)
    assert.ok(tr1, 'trace1')
    assert.equal(tr1.argv, undefined)
    assert.equal(tr1.body.messages[0].content, 'turn-one-hello')

    const t2 = await api(gw, 'POST', '/v1/messages', {
      headers: h,
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'turn-one-hello' },
          { role: 'assistant', content: 'ack' },
          { role: 'user', content: 'turn-two-followup' },
        ],
      },
    })
    assert.equal(t2.status, 200, t2.text)
    const tr2 = takeTrace(gw)
    assert.ok(tr2, 'trace2')
    assert.equal(tr2.argv, undefined)
    assert.equal(tr2.body.messages.length, 3)
    assert.equal(tr2.body.messages[0].content, 'turn-one-hello')
    assert.equal(tr2.body.messages[2].content, 'turn-two-followup')
  } finally {
    await gw.stop()
  }
})

test('one sticky session holds across three protocols and stream', async () => {
  const gw = await startGateway({ mockText: 'ack' })
  try {
    const h = { 'x-session-id': 'conv-multi-proto-1', 'x-kin-forward': 'cli' }

    const a = await api(gw, 'POST', '/v1/messages', {
      headers: h,
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'p-anthropic' }] },
    })
    assert.equal(a.status, 200, a.text)
    assert.equal(takeTrace(gw).argv, undefined)

    const b = await api(gw, 'POST', '/v1/chat/completions', {
      headers: h,
      body: { model: MODEL, messages: [{ role: 'user', content: 'p-openai-chat' }] },
    })
    assert.equal(b.status, 200, b.text)
    assert.match(JSON.stringify(b.json), /ack/)
    const trChat = takeTrace(gw)
    assert.equal(trChat.argv, undefined)
    assert.match(JSON.stringify(trChat.body.messages), /p-openai-chat/)

    const c = await api(gw, 'POST', '/v1/responses', {
      headers: h,
      body: { model: MODEL, input: 'p-openai-responses' },
    })
    assert.equal(c.status, 200, c.text)
    const trResp = takeTrace(gw)
    assert.equal(trResp.argv, undefined)
    assert.match(JSON.stringify(trResp.body.messages), /p-openai-responses/)

    const res = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'x-kin-forward': 'cli',
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
        'x-session-id': 'conv-multi-proto-1',
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'p-stream' }],
      }),
    })
    assert.equal(res.status, 200)
    const sse = await res.text()
    assert.match(sse, /event:/)
    assert.match(sse, /data:/)
    const trSse = takeTrace(gw)
    assert.equal(trSse.argv, undefined)
    assert.match(JSON.stringify(trSse.body.messages), /p-stream/)

    const snap = await api(gw, 'GET', '/admin/routing')
    assert.equal(snap.status, 200, snap.text)
    const sessions = snap.json?.sticky?.sessions || {}
    const hit = sessions['conv-multi-proto-1']
    assert.ok(hit, `missing sticky bind: ${JSON.stringify(snap.json?.sticky)}`)
    assert.equal(hit.session_id, null)
    assert.ok(hit.hits >= 4, `hits=${hit.hits}`)
    assert.equal(hit.vm_id, 'vm-sim-01')
    assert.equal(hit.account_id, 'acct-seed')
  } finally {
    await gw.stop()
  }
})

test('different x-session-id creates independent sticky bindings', async () => {
  const gw = await startGateway({ mockText: 'ack' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli', 'x-session-id': 'conv-A' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'only-A' }] },
    })
    takeTrace(gw)
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli', 'x-session-id': 'conv-B' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'only-B' }] },
    })
    const trB = takeTrace(gw)
    assert.ok(trB)
    assert.equal(trB.argv, undefined)
    assert.equal(trB.body.messages[0].content, 'only-B')
    const snap = await api(gw, 'GET', '/admin/routing')
    assert.ok(snap.json.sticky.sessions['conv-A'])
    assert.ok(snap.json.sticky.sessions['conv-B'])
  } finally {
    await gw.stop()
  }
})

test('sticky bindings persist in sqlite after a long sequential session', async () => {
  const gw = await startGateway({ mockText: 'n' })
  try {
    const h = { 'x-session-id': 'conv-long-n', 'x-kin-forward': 'cli' }
    for (let i = 0; i < 6; i++) {
      const r = await api(gw, 'POST', '/v1/messages', {
        headers: h,
        body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: `n-${i}` }] },
      })
      assert.equal(r.status, 200, r.text)
      const tr = takeTrace(gw)
      assert.equal(tr.argv, undefined)
      assert.equal(tr.body.messages[0].content, `n-${i}`)
    }
    // sticky bindings now live in the SQLite store (data/kin.db)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT * FROM sticky_sessions WHERE key = ?').get('conv-long-n')
      assert.ok(row, 'sticky binding row should exist in DB')
      assert.equal(row.session_id, null)
      assert.ok(row.hits >= 6)
    } finally {
      db.close()
    }
  } finally {
    await gw.stop()
  }
})
