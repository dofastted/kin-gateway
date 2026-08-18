import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, latestHopMeta } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('capture hop_meta.params.dropped includes max_tokens and temperature', async () => {
  const gw = await startGateway({ scenario: 'thinking' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 99,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 512 },
        messages: [{ role: 'user', content: 'think' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const meta = latestHopMeta(gw)
    assert.ok(meta, 'hop_meta captured')
    assert.ok(meta.params.dropped.includes('max_tokens'), JSON.stringify(meta.params))
    assert.ok(meta.params.dropped.includes('temperature'), JSON.stringify(meta.params))
    assert.equal(meta.params.thinking_budget, 512)
  } finally {
    await gw.stop()
  }
})

test('capture hop_meta.system.truncated=true for >24k system', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 8,
        system: 'S'.repeat(30000),
        messages: [{ role: 'user', content: 'x' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const meta = latestHopMeta(gw)
    assert.ok(meta?.system?.truncated)
    assert.equal(meta.system.kept_len, 24000)
    assert.ok(meta.system.orig_len > 24000)
  } finally {
    await gw.stop()
  }
})
