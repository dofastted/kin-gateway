import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestLogStore, resolveLogMode, summarizeBody, newRequestId } from './request-log.mjs'

function tmpStore(mode = 'normal') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-'))
  return new RequestLogStore({ dataDir: dir, mode })
}

test('resolveLogMode: env + header overrides', () => {
  assert.equal(resolveLogMode('normal', { headers: {} }), 'normal')
  assert.equal(resolveLogMode('normal', { headers: { 'x-kin-debug': '1' } }), 'debug')
  assert.equal(resolveLogMode('debug', { headers: { 'x-kin-log': 'off' } }), 'off')
  assert.equal(resolveLogMode('off', { headers: { 'x-kin-log': 'normal' } }), 'normal')
})

test('newRequestId keeps incoming X-Request-ID', () => {
  assert.equal(newRequestId({ headers: { 'x-request-id': 'rid-1' } }), 'rid-1')
  assert.match(newRequestId({ headers: {} }), /^[0-9a-f-]{36}$/i)
})

test('summarizeBody counts messages and tools', () => {
  const s = summarizeBody({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    tools: [{ name: 'Read' }],
    system: 'x'.repeat(10),
  })
  assert.equal(s.messages_count, 2)
  assert.equal(s.tools_count, 1)
  assert.equal(s.system_len, 10)
})

test('normal mode writes jsonl without body', () => {
  const store = tmpStore('normal')
  const ctx = store.start({ method: 'POST', headers: { 'user-agent': 't' }, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
  assert.equal(ctx.mode, 'normal')
  const sum = store.finish(ctx, {
    status: 200,
    model: 'claude-haiku-4-5-20251001',
    stream: false,
    inbound_body: { messages: [{ role: 'user', content: 'secret sk-ant-oat01-ABCDEFGH12345678' }] },
    api_key_kind: 'managed',
    api_key_id: 'key_1',
  })
  assert.equal(sum.status, 200)
  assert.equal(sum.api_key_id, 'key_1')
  assert.equal(sum.inbound_body, undefined)
  const listed = store.listNormal({ limit: 5 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].request_id, ctx.request_id)
  // no debug file
  assert.equal(store.listDebug({ limit: 5 }).length, 0)
})

test('debug mode stores full redacted body', () => {
  const store = tmpStore('normal')
  const req = { method: 'POST', headers: { 'x-kin-debug': '1', authorization: 'Bearer sk-kin-abc' }, socket: {} }
  const ctx = store.start(req, { protocol: 'openai.chat', pathName: '/v1/chat/completions' })
  assert.equal(ctx.mode, 'debug')
  store.finish(ctx, {
    status: 200,
    model: 'm',
    inbound_body: { model: 'm', messages: [{ role: 'user', content: 'hi sk-ant-oat01-ABCDEFGH12345678' }] },
    hop_meta: { params: { dropped: ['max_tokens'] } },
  })
  const dbg = store.listDebug({ limit: 5 })
  assert.equal(dbg.length, 1)
  assert.equal(dbg[0].request_id, ctx.request_id)
  assert.ok(dbg[0].headers.authorization === '***REDACTED***')
  const bodyStr = JSON.stringify(dbg[0].inbound_body)
  assert.match(bodyStr, /REDACTED/)
  assert.doesNotMatch(bodyStr, /ABCDEFGH12345678/)
  assert.deepEqual(dbg[0].hop_meta.params.dropped, ['max_tokens'])
})

test('off mode writes nothing', () => {
  const store = tmpStore('off')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: '/v1/messages' })
  assert.equal(ctx.mode, 'off')
  assert.equal(store.finish(ctx, { status: 200 }), null)
  assert.equal(store.listNormal({ limit: 5 }).length, 0)
})
