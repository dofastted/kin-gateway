import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('x-kin-workspace: vm is rejected after Claude CLI removal', async () => {
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
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.error.code, 'vm_workspace_removed')
  } finally {
    await gw.stop()
  }
})
