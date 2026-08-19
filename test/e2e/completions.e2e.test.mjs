import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'
import { CRS_OFFICIAL_SYSTEM } from '../../src/lib/crs-persona.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('POST /v1/completions old OpenAI prompt format', async () => {
  const gw = await startGateway({ mockText: 'world' })
  try {
    const r = await api(gw, 'POST', '/v1/completions', {
      body: { model: MODEL, prompt: 'hello', max_tokens: 16 },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.object, 'text_completion')
    assert.equal(r.json.choices[0].text, 'world')
    const tr = readTrace(gw)
    assert.equal(tr.via, 'go-worker')
    assert.match(JSON.stringify(tr.body.messages), /hello/)
    assert.equal(tr.system, CRS_OFFICIAL_SYSTEM)
  } finally {
    await gw.stop()
  }
})

test('POST /v1/completions keeps third-party system via prompt-only (no system field)', async () => {
  const gw = await startGateway({ mockText: 'ok' })
  try {
    const r = await api(gw, 'POST', '/completions', {
      body: { model: MODEL, prompt: ['line-a', 'line-b'], max_tokens: 8, stream: false },
    })
    assert.equal(r.status, 200, r.text)
    const tr = readTrace(gw)
    assert.match(JSON.stringify(tr.body.messages), /line-a/)
    assert.match(JSON.stringify(tr.body.messages), /line-b/)
  } finally {
    await gw.stop()
  }
})
