import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestLogStore, resolveLogMode, summarizeBody, newRequestId } from '../../src/lib/admin/request-log.mjs'

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

test('summary persists protocol usage detail (cache/model/ttft/stop_reason)', () => {
  const store = tmpStore('normal')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
  const sum = store.finish(ctx, {
    status: 200,
    model: 'sonnet',
    requested_model: 'sonnet',
    upstream_model: 'claude-sonnet-5',
    first_token_ms: 42,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 },
    },
  })
  assert.equal(sum.cache_read_tokens, 3)
  assert.equal(sum.cache_creation_tokens, 7)
  assert.equal(sum.cache_creation_5m_tokens, 4)
  assert.equal(sum.cache_creation_1h_tokens, 3)
  assert.equal(sum.requested_model, 'sonnet')
  assert.equal(sum.upstream_model, 'claude-sonnet-5')
  assert.equal(sum.model_mismatch, 1)
  assert.equal(sum.first_token_ms, 42)
  assert.equal(sum.stop_reason, 'end_turn')
  // Sonnet 5 official: $2/$10/cache 5m $2.50/1h $4/read $0.20 per MTok
  assert.equal(sum.pricing_model, 'sonnet-5')
  assert.ok(Math.abs(sum.total_cost - 0.0000926) < 1e-12)
  const row = store.queryNormal({ limit: 1 }).items[0]
  assert.equal(row.cache_creation_5m_tokens, 4)
  assert.equal(row.upstream_model, 'claude-sonnet-5')
  assert.equal(row.stop_reason, 'end_turn')
  assert.equal(row.total_cost, 0.0000926)
})

test('backfillMissingCosts prices historical rows that predate cost columns', () => {
  const store = tmpStore('normal')
  store.db.prepare(`
    INSERT INTO request_logs (id, request_id, ts, model, upstream_model, status, input_tokens, output_tokens, vm_id, account_id)
    VALUES ('log_old_bill', 'rid_old_bill', ?, 'claude-opus-5', 'claude-opus-5', 200, 1000000, 0, 'vm-01', 'acc-old')
  `).run(new Date().toISOString())
  assert.equal(store.repo.backfillMissingCosts(), 1)
  const row = store.db.prepare("SELECT total_cost, pricing_model FROM request_logs WHERE id = 'log_old_bill'").get()
  assert.equal(row.pricing_model, 'opus-5')
  assert.equal(row.total_cost, 5)
})

test('billingStats aggregates official cost per account and today', () => {
  const store = tmpStore('normal')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
  store.finish(ctx, {
    status: 200,
    model: 'claude-opus-5',
    upstream_model: 'claude-opus-5',
    vm_id: 'vm-01',
    account_id: 'acc-1',
    usage: { input_tokens: 1_000_000, output_tokens: 0 },
  })
  const bill = store.billingStats()
  assert.equal(bill.currency, 'USD')
  assert.equal(bill.total.total_cost, 5)
  assert.equal(bill.today.total_cost, 5)
  assert.equal(bill.accounts[0].account_id, 'acc-1')
  assert.equal(bill.accounts[0].total_cost, 5)
  assert.equal(bill.accounts[0].window_5h_cost, 5)
  assert.ok(bill.window_5h)
  assert.equal(bill.window_5h.total_cost, 5)
})

test('finish prices OpenAI-shaped usage from third-party clients', () => {
  const store = tmpStore('normal')
  const ctx = store.start({ method: 'POST', headers: { 'user-agent': 'OpenAI/Python 1.70.0' }, socket: {} }, { protocol: 'openai.chat', pathName: '/v1/chat/completions' })
  const sum = store.finish(ctx, {
    status: 200,
    protocol: 'openai.chat',
    model: 'claude-sonnet-5',
    upstream_model: 'claude-sonnet-5',
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
    },
  })
  assert.equal(sum.input_tokens, 1_000_000)
  assert.equal(sum.cache_read_tokens, 1_000_000)
  assert.equal(sum.total_cost, 2.2)
})

test('cache breakdown falls back to the 5m bucket (sub2api normalization)', () => {
  const store = tmpStore('normal')
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
  const sum = store.finish(ctx, {
    status: 200,
    model: 'claude-sonnet-5',
    upstream_model: 'claude-sonnet-5',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9 },
  })
  assert.equal(sum.cache_creation_5m_tokens, 9)
  assert.equal(sum.cache_creation_1h_tokens, 0)
  assert.equal(sum.model_mismatch, 0)
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

function logOne(store, extra = {}) {
  const ctx = store.start({ method: 'POST', headers: {}, socket: {} }, { pathName: extra.path || '/v1/messages' })
  return store.finish(ctx, { status: 200, ...extra })
}

test('summaries persist in sqlite across store re-open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-'))
  const s1 = new RequestLogStore({ dataDir: dir, mode: 'normal' })
  logOne(s1, { model: 'claude-haiku-4-5', api_key_id: 'key_p' })

  const s2 = new RequestLogStore({ dataDir: dir, mode: 'normal' })
  const listed = s2.listNormal({ limit: 10 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].api_key_id, 'key_p')
  assert.equal(s2.snapshot().total_rows, 1)
})

test('queryNormal filters + pagination + total', () => {
  const store = tmpStore('normal')
  logOne(store, { api_key_id: 'key_a', model: 'm1', input_tokens: 10, output_tokens: 5 })
  logOne(store, { api_key_id: 'key_a', model: 'm2', status: 500, error_code: 'upstream_error' })
  logOne(store, { api_key_id: 'key_b', model: 'm1', vm_id: 'vm-9' })

  assert.equal(store.queryNormal({ api_key_id: 'key_a' }).total, 2)
  assert.equal(store.queryNormal({ vm_id: 'vm-9' }).total, 1)
  assert.equal(store.queryNormal({ model: 'm1' }).total, 2)
  assert.equal(store.queryNormal({ status: 'error' }).total, 1)
  assert.equal(store.queryNormal({ status: 'ok' }).total, 2)
  assert.equal(store.queryNormal({ q: 'upstream' }).total, 1)
  const page = store.queryNormal({ limit: 2, offset: 2 })
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 1)
})

test('windowStats computes ttft percentiles, sla and qps', () => {
  const store = tmpStore('normal')
  logOne(store, { status: 200, first_token_ms: 100, duration_ms: 200, input_tokens: 10, output_tokens: 20, model: 'claude-sonnet-5' })
  logOne(store, { status: 200, first_token_ms: 300, duration_ms: 400, input_tokens: 10, output_tokens: 20, model: 'claude-sonnet-5' })
  logOne(store, { status: 503, error_code: 'overloaded', duration_ms: 50, model: 'claude-fable-5' })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.requests, 3)
  assert.equal(w.success, 2)
  assert.equal(w.errors, 1)
  assert.equal(w.status_503, 1)
  assert.equal(w.ttft.samples, 2)
  assert.equal(w.ttft.p50_ms, 100)
  assert.equal(w.ttft.max_ms, 300)
  assert.ok(Math.abs(w.sla - 2 / 3) < 1e-9)
  assert.ok(w.qps.avg > 0)
  assert.equal(w.by_model.length, 2)
  assert.equal(w.error_collection.total, 1)
  assert.equal(w.error_collection.by_class[0].id, 'overloaded')
  const filtered = store.queryNormal({ error_class: 'overloaded' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.items[0].error_label, '过载排队')
})

test('windowStats treats 429 quota/rate-limit as SLA success', () => {
  const store = tmpStore('normal')
  logOne(store, { status: 200, first_token_ms: 80, duration_ms: 100, model: 'claude-sonnet-5' })
  logOne(store, { status: 429, error_code: 'upstream_rate_limit', error_message: '5h extra usage', model: 'claude-opus-5' })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.requests, 2)
  assert.equal(w.success, 2)
  assert.equal(w.errors, 0)
  assert.equal(w.status_429, 1)
  assert.equal(w.sla, 1)
  assert.equal(w.error_collection.total, 1)
  assert.equal(w.error_collection.by_class[0].id, 'rate_limit')
})

test('windowStats ignores client abort like sub2api ignore_context_canceled', () => {
  const store = tmpStore('normal')
  logOne(store, { status: 200, first_token_ms: 80, duration_ms: 100, model: 'claude-sonnet-5' })
  logOne(store, { status: 200, error_code: 'client_cancelled', error_message: 'ECONNRESET', model: 'claude-sonnet-5' })
  const w = store.windowStats({ since: new Date(Date.now() - 60_000).toISOString() })
  assert.equal(w.requests, 2)
  assert.equal(w.success, 2)
  assert.equal(w.errors, 0)
  assert.equal(w.error_collection.total, 0)
  assert.equal(store.queryNormal({ status: 'error' }).total, 0)
})

test('aggregate buckets by day with token sums', () => {
  const store = tmpStore('normal')
  logOne(store, { input_tokens: 10, output_tokens: 5 })
  logOne(store, { input_tokens: 20, output_tokens: 15, status: 500, error_code: 'x' })
  const rows = store.aggregate({ bucket: 'day' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requests, 2)
  assert.equal(rows[0].errors, 1)
  assert.equal(rows[0].input_tokens, 30)
  assert.equal(rows[0].output_tokens, 20)
  const totals = store.totals()
  assert.equal(totals.requests, 2)
  assert.equal(totals.input_tokens, 30)
})

test('cleanup removes rows older than retainDays', () => {
  const store = tmpStore('normal')
  // one fresh row
  logOne(store, {})
  // one stale row injected directly
  store.repo.insertSummary({
    id: 'log_old', request_id: 'rid-old',
    ts: new Date(Date.now() - 30 * 86400_000).toISOString(),
  })
  store.repo.insertDebug('rid-old', new Date(Date.now() - 30 * 86400_000).toISOString(), { old: true })
  assert.equal(store.repo.count(), 2)
  store.cleanup()
  assert.equal(store.repo.count(), 1)
  assert.equal(store.getDebug('rid-old'), null)
})

test('jsonl mirror writes legacy format when enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-rlog-'))
  const store = new RequestLogStore({ dataDir: dir, mode: 'normal', jsonlMirror: true })
  logOne(store, { model: 'mm' })
  const day = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, 'request-logs', `${day}.jsonl`)
  assert.ok(fs.existsSync(file))
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  assert.equal(rec.model, 'mm')
})

test('sanitizeRequestBodySnapshot redacts secrets and summarizes tools', async () => {
  const { sanitizeRequestBodySnapshot } = await import('../../src/lib/admin/request-log.mjs')
  const snap = sanitizeRequestBodySnapshot({
    model: 'claude-haiku-4-5-20251001',
    authorization: 'Bearer secret',
    tools: [{ name: 'Read', type: 'custom' }, { function: { name: 'write' } }],
    messages: [{ role: 'user', content: 'x'.repeat(200) }],
  })
  assert.equal(snap.authorization, '[REDACTED]')
  assert.equal(snap.tools[0].name, 'Read')
  assert.ok(String(snap.messages[0].content).includes('…'))
})

test('setConfig hot-updates mode', () => {
  const s = tmpStore('normal')
  s.setConfig({ mode: 'debug', retainDays: 3 })
  const snap = s.snapshot()
  assert.equal(snap.mode, 'debug')
  assert.equal(snap.retain_days, 3)
})
