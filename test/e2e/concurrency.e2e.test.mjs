import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('concurrent hops leave valid vm.json without writing secrets', async () => {
  const gw = await startGateway({ mockText: 'c' })
  try {
    const n = 8
    const results = await Promise.all(Array.from({ length: n }, () => api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })))
    for (const r of results) assert.equal(r.status, 200, r.text)
    const raw = fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8')
    const rec = JSON.parse(raw)
    assert.ok(rec.claude.has_access || rec.claude.access_token)
    assert.equal(rec.claude.session_key, undefined)
  } finally {
    await gw.stop()
  }
})
