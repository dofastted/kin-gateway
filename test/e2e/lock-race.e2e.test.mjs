import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('concurrent sessionKey import vs harvest leaves valid vm.json', async () => {
  const gw = await startGateway()
  try {
    const home = path.join(gw.project, 'vms', 'vm-sim-01', 'cli-home', '.claude')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-HARVEST-RACE',
        refreshToken: 'sk-ant-ort01-HARVEST-RACE',
        expiresAt: Date.now() + 9 * 3600 * 1000,
      },
    }))

    const results = await Promise.all([
      api(gw, 'POST', '/api/panel/vms/import', {
        body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid-test-raceaaaa', require_proxy: false },
      }),
      api(gw, 'POST', '/admin/vm/oauth/refresh', { body: { force: true } }),
      api(gw, 'POST', '/api/panel/vms/import', {
        body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid-test-racebbbb', require_proxy: false },
      }),
      api(gw, 'POST', '/admin/vm/oauth/refresh', { body: {} }),
    ])
    for (const r of results) {
      assert.ok(r.status === 200 || r.status === 401, r.text)
    }

    const raw = fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8')
    const rec = JSON.parse(raw)
    assert.ok(rec.claude?.access_token)
    assert.match(rec.claude.access_token, /FAKE-SIM|HARVEST-RACE/)
    assert.ok(rec.claude._token_version)
    assert.notEqual(rec.claude.grant_type, 'refresh_token')
  } finally {
    await gw.stop()
  }
})
