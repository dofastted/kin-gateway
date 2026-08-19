import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore, generateApiKey, maskApiKey } from '../../src/lib/api-keys.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  return new ApiKeyStore({ dataDir: dir })
}

test('generateApiKey uses sk-kin- prefix and is long enough', () => {
  const k = generateApiKey()
  assert.match(k, /^sk-kin-[a-f0-9]{64}$/)
  assert.notEqual(k, generateApiKey())
})

test('maskApiKey hides middle', () => {
  const k = 'sk-kin-' + 'a'.repeat(64)
  const m = maskApiKey(k)
  assert.ok(m.includes('…'))
  assert.ok(!m.includes('a'.repeat(20)))
})

test('create + authenticate + list mask', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'demo', max_concurrency: 3, quota_requests: 10, rpm: 60 })
  assert.equal(rec.name, 'demo')
  assert.equal(rec.max_concurrency, 3)
  assert.equal(rec.quota_requests, 10)
  const auth = store.authenticate(rec.key)
  assert.equal(auth.ok, true)
  assert.equal(auth.record.id, rec.id)
  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.ok(listed[0].key.includes('…'))
  assert.notEqual(listed[0].key, rec.key)
})

test('canAccept rejects disabled / expired / quota / concurrency', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'lim', max_concurrency: 1, quota_requests: 2, rpm: 0 })
  assert.equal(store.canAccept(rec).ok, true)

  store.update(rec.id, { status: 'disabled' })
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_disabled')
  store.update(rec.id, { status: 'active' })

  store.update(rec.id, { expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_expired')
  store.update(rec.id, { expires_at: null })

  const a = store.acquire(store.getById(rec.id))
  assert.equal(a.ok, true)
  const blocked = store.canAccept(store.getById(rec.id))
  assert.equal(blocked.code, 'api_key_concurrency_limit')
  store.release(rec.id)

  store.recordUsage(rec.id)
  store.recordUsage(rec.id)
  assert.equal(store.canAccept(store.getById(rec.id)).code, 'api_key_quota_exhausted')
})

test('rpm window blocks then recovers', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'rpm', max_concurrency: 0, quota_requests: 0, rpm: 2 })
  assert.equal(store.acquire(rec).ok, true)
  store.release(rec)
  assert.equal(store.acquire(rec).ok, true)
  store.release(rec)
  const gate = store.canAccept(store.getById(rec.id))
  assert.equal(gate.code, 'api_key_rate_limit')
})

test('update reset_quota and remove', () => {
  const store = tmpStore()
  const rec = store.create({ name: 'x', quota_requests: 5 })
  store.recordUsage(rec.id)
  store.recordUsage(rec.id)
  assert.equal(store.getById(rec.id).quota_used, 2)
  store.update(rec.id, { reset_quota: true })
  assert.equal(store.getById(rec.id).quota_used, 0)
  assert.equal(store.remove(rec.id), true)
  assert.equal(store.getById(rec.id), null)
  assert.equal(store.authenticate(rec.key).ok, false)
})

test('custom key rejected when duplicate', () => {
  const store = tmpStore()
  store.create({ name: 'a', key: 'sk-kin-customkey0001' })
  assert.throws(() => store.create({ name: 'b', key: 'sk-kin-customkey0001' }), /exists/)
})

test('keys persist in sqlite across store re-open (same dataDir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = store.create({ name: 'persist', quota_requests: 9 })
  store.recordUsage(rec.id, { input_tokens: 11, output_tokens: 22 })

  const store2 = new ApiKeyStore({ dataDir: dir })
  const again = store2.getById(rec.id)
  assert.ok(again, 'record should survive re-open')
  assert.equal(again.name, 'persist')
  assert.equal(again.quota_used, 1)
  assert.equal(again.tokens_in, 11)
  assert.equal(again.tokens_out, 22)
  assert.equal(store2.authenticate(rec.key).ok, true)
  assert.ok(fs.existsSync(path.join(dir, 'kin.db')), 'kin.db file exists')
})
