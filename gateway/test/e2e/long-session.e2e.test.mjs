/**
 * Long-session + multi-protocol: same x-session-id across sequential hops.
 * After turn 1 the mock session_id is bound; later hops must --resume
 * and send only the trailing user turn (history lives in the CLI session).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api, takeTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'
const SID = 'conv-long-sim-001'

function hasResume(tr, sessionId = 'sess-mock-1') {
  if (!tr?.argv) return false
  const i = tr.argv.indexOf('--resume')
  return i >= 0 && tr.argv[i + 1] === sessionId
}

test('same x-session-id: turn1 no resume, later hops --resume and drop history', async () => {
  const gw = await startGateway({ mockText: 'ack' })
  try {
    const h = { 'x-session-id': SID }

    const t1 = await api(gw, 'POST', '/v1/messages', {
      headers: h,
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'turn-one-hello' }] },
    })
    assert.equal(t1.status, 200, t1.text)
    const tr1 = takeTrace(gw)
    assert.ok(tr1, 'trace1')
    assert.equal(hasResume(tr1), false, 'first hop must not --resume')
    assert.match(tr1.stdin, /turn-one-hello/)

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
    assert.equal(hasResume(tr2), true, `expected --resume sess-mock-1, argv=${JSON.stringify(tr2.argv)}`)
    assert.match(tr2.stdin, /turn-two-followup/)
    assert.doesNotMatch(tr2.stdin, /turn-one-hello/)
  } finally {
    await gw.stop()
  }
})

test('one sticky session, three protocols + stream, resume holds', async () => {
  const gw = await startGateway({ mockText: 'ack' })
  try {
    const h = { 'x-session-id': 'conv-multi-proto-1' }

    const a = await api(gw, 'POST', '/v1/messages', {
      headers: h,
      body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'p-anthropic' }] },
    })
    assert.equal(a.status, 200, a.text)
    assert.equal(hasResume(takeTrace(gw)), false)

    const b = await api(gw, 'POST', '/v1/chat/completions', {
      headers: h,
      body: { model: MODEL, messages: [{ role: 'user', content: 'p-openai-chat' }] },
    })
    assert.equal(b.status, 200, b.text)
    assert.match(JSON.stringify(b.json), /ack/)
    const trChat = takeTrace(gw)
    assert.equal(hasResume(trChat), true)
    assert.match(trChat.stdin, /p-openai-chat/)
    assert.doesNotMatch(trChat.stdin, /p-anthropic/)

    const c = await api(gw, 'POST', '/v1/responses', {
      headers: h,
      body: { model: MODEL, input: 'p-openai-responses' },
    })
    assert.equal(c.status, 200, c.text)
    const trResp = takeTrace(gw)
    assert.equal(hasResume(trResp), true)
    assert.match(trResp.stdin, /p-openai-responses/)

    const res = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
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
    assert.equal(hasResume(trSse), true)
    assert.match(trSse.stdin, /p-stream/)

    const snap = await api(gw, 'GET', '/admin/routing')
    assert.equal(snap.status, 200, snap.text)
    const sessions = snap.json?.sticky?.sessions || {}
    const hit = sessions['conv-multi-proto-1']
    assert.ok(hit, `missing sticky bind: ${JSON.stringify(snap.json?.sticky)}`)
    assert.equal(hit.session_id, 'sess-mock-1')
    assert.ok(hit.hits >= 4, `hits=${hit.hits}`)
    assert.equal(hit.vm_id, 'vm-sim-01')
  } finally {
    await gw.stop()
  }
})

test('different x-session-id does not inherit --resume', async () => {
  const gw = await startGateway({ mockText: 'ack' })
  try {
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-session-id': 'conv-A' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'only-A' }] },
    })
    takeTrace(gw)
    await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-session-id': 'conv-B' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'only-B' }] },
    })
    const trB = takeTrace(gw)
    assert.ok(trB)
    assert.equal(hasResume(trB), false, 'new conversation must start clean')
    assert.match(trB.stdin, /only-B/)
  } finally {
    await gw.stop()
  }
})

test('sticky bindings persist in sqlite after a long sequential session', async () => {
  const gw = await startGateway({ mockText: 'n' })
  try {
    const h = { 'x-session-id': 'conv-long-n' }
    for (let i = 0; i < 6; i++) {
      const r = await api(gw, 'POST', '/v1/messages', {
        headers: h,
        body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: `n-${i}` }] },
      })
      assert.equal(r.status, 200, r.text)
      const tr = takeTrace(gw)
      if (i === 0) assert.equal(hasResume(tr), false)
      else assert.equal(hasResume(tr), true)
    }
    // sticky bindings now live in the SQLite store (data/kin.db)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT * FROM sticky_sessions WHERE key = ?').get('conv-long-n')
      assert.ok(row, 'sticky binding row should exist in DB')
      assert.equal(row.session_id, 'sess-mock-1')
      assert.ok(row.hits >= 6)
    } finally {
      db.close()
    }
  } finally {
    await gw.stop()
  }
})
