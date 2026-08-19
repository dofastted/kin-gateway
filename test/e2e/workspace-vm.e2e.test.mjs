import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('x-kin-workspace: vm uses acceptEdits + Read allowlist', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'vm-pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-workspace': 'vm' },
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.ok(tr, 'trace')
    const a = tr.argv
    assert.ok(a.includes('--permission-mode'))
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits')
    const allow = a[a.indexOf('--allowedTools') + 1] || ''
    assert.match(allow, /Read/)
  } finally {
    await gw.stop()
  }
})
