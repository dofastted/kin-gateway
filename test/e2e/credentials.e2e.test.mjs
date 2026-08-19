import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api, seedVm } from '../harness.mjs'

test('sessionKey import writes via persistOauthToVm (fake oauth)', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/api/panel/vms/import', {
      body: {
        vm_id: 'vm-sim-01',
        sessionKey: 'sk-ant-sid-test-bbbbbbbb',
        require_proxy: false,
      },
    })
    assert.equal(r.status, 200, r.text)
    const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(rec.claude.email, 'fake-oauth@kin.test')
    assert.equal(rec.claude.access_token, 'sk-ant-oat01-FAKE-SIM')
    assert.equal(rec.claude.source, 'KIN_FAKE_SESSION_OAUTH')
    assert.ok(rec.claude._token_version)
    assert.match(rec.claude.session_key, /^sk-ant-sid/)
  } finally {
    await gw.stop()
  }
})

test('harvest refresh reads cli-home credentials, no grant_type', async () => {
  const gw = await startGateway()
  try {
    const home = path.join(gw.project, 'vms', 'vm-sim-01', 'cli-home', '.claude')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-HARVESTED',
        refreshToken: 'sk-ant-ort01-HARVESTED',
        expiresAt: Date.now() + 8 * 3600 * 1000,
      },
    }))
    const r = await api(gw, 'POST', '/admin/vm/oauth/refresh', { body: {} })
    assert.equal(r.status, 200, r.text)
    assert.notEqual(r.json.grant_type, 'refresh_token')
    const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    assert.equal(rec.claude.access_token, 'sk-ant-oat01-HARVESTED')
  } finally {
    await gw.stop()
  }
})

test('reset clear_oauth unschedules the VM', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/reset', {
      body: { clear_oauth: true },
    })
    assert.ok(r.status === 200 || r.status === 404, r.text)
    if (r.status === 200) {
      const rec = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
      assert.ok(!rec.claude?.access_token)
    }
  } finally {
    await gw.stop()
  }
})
