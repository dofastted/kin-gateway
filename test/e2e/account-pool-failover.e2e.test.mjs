import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, seedVm } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('account1 quota exhaustion rotates to account2 and commits sticky final account', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-e2e-'))
  const firstVm = seedVm({ project, id: 'vm-sim-01' })
  firstVm.claude.account_uuid = 'account-1'
  fs.writeFileSync(path.join(project, 'vms', 'vm-sim-01.json'), JSON.stringify(firstVm, null, 2))
  const second = seedVm({ project, id: 'vm-sim-02' })
  second.claude.account_uuid = 'account-2'
  second.claude.email = 'second@kin.test'
  fs.writeFileSync(path.join(project, 'vms', 'vm-sim-02.json'), JSON.stringify(second, null, 2))

  const gw = await startGateway({
    project,
    env: {
      KIN_MOCK_ACCOUNT_SCENARIOS: JSON.stringify({
        'vm-sim-01': 'rate_limit',
        'vm-sim-02': 'text',
      }),
    },
  })
  try {
    const headers = {
      'x-session-id': 'pool-conversation-1',
      'x-kin-debug': '1',
    }
    const first = await api(gw, 'POST', '/v1/messages', {
      headers,
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'first' }],
      },
    })
    assert.equal(first.status, 200, first.text)
    assert.equal(first.json.kin.account_id, 'account-2')
    assert.equal(first.json.kin.vm_id, 'vm-sim-02')
    assert.equal(first.json.kin.attempts, 2)
    assert.equal(first.json.kin.terminal_state, 'verified')

    const secondTurn = await api(gw, 'POST', '/v1/messages', {
      headers,
      body: {
        model: MODEL,
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'pong' },
          { role: 'user', content: 'second' },
        ],
      },
    })
    assert.equal(secondTurn.status, 200, secondTurn.text)
    assert.equal(secondTurn.json.kin.account_id, 'account-2')
    assert.equal(secondTurn.json.kin.attempts, 1)

    const routing = await api(gw, 'GET', '/admin/routing')
    const sticky = routing.json?.sticky?.sessions?.['pool-conversation-1']
    assert.equal(sticky.account_id, 'account-2')
    assert.equal(sticky.vm_id, 'vm-sim-02')
  } finally {
    await gw.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})
