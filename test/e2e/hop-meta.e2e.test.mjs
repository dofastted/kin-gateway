import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('CRS default keeps thinking + max_tokens + temperature in official body', async () => {
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
    const tr = readTrace(gw)
    assert.equal(tr?.via, 'go-worker')
    assert.equal(tr.body.max_tokens, 99)
    assert.equal(tr.body.temperature, 0.2)
    assert.equal(tr.body.thinking.budget_tokens, 512)
    assert.ok((tr.tools || []).includes('web_search'))
  } finally {
    await gw.stop()
  }
})

test('CRS default does not truncate a long official system (unofficial is replaced)', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'user-agent': 'claude-cli/2.1.234 (external, sdk-cli)' },
      body: {
        model: MODEL,
        max_tokens: 8,
        system: 'S'.repeat(30000),
        messages: [{ role: 'user', content: 'x' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.equal(tr?.via, 'go-worker')
    assert.equal(String(tr.system || '').length, 30000)
    assert.ok(!(tr.tools || []).includes('web_search'))
  } finally {
    await gw.stop()
  }
})

test('legacy CLI selector cannot drop HTTP request parameters', async () => {
  const gw = await startGateway({ scenario: 'thinking' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: {
        model: MODEL,
        max_tokens: 99,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 512 },
        messages: [{ role: 'user', content: 'think' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const trace = readTrace(gw)
    assert.equal(trace.argv, undefined)
    assert.equal(trace.body.max_tokens, 99)
    assert.equal(trace.body.temperature, 0.2)
    assert.equal(trace.body.thinking.budget_tokens, 512)
  } finally {
    await gw.stop()
  }
})
