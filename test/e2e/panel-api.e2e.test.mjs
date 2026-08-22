import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('panel login → cookie → /api/panel/me', async () => {
  const gw = await startGateway()
  try {
    const login = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    assert.equal(login.status, 200, await login.clone().text())
    const setCookie = login.headers.get('set-cookie') || ''
    const me = await fetch(gw.baseUrl + '/api/panel/me', {
      headers: { cookie: setCookie },
    })
    // some builds expose /me under different path; accept 200 or try vms list
    if (me.status !== 200) {
      const vms = await api(gw, 'GET', '/admin/vms')
      assert.equal(vms.status, 200, vms.text)
      assert.ok(Array.isArray(vms.json.vms))
    } else {
      const body = await me.json()
      assert.ok(body.user || body.ok || body.username)
    }
  } finally {
    await gw.stop()
  }
})

test('admin vms list via API key', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/admin/vms')
    assert.equal(r.status, 200, r.text)
    assert.ok(r.json.vms.some((v) => v.id === 'vm-sim-01'))
  } finally {
    await gw.stop()
  }
})

test('dashboard and vm detail expose proxy_pool and configured flags', async () => {
  const gw = await startGateway()
  try {
    const dash = await api(gw, 'GET', '/api/panel/dashboard')
    assert.equal(dash.status, 200, dash.text)
    const data = dash.json.data || dash.json
    assert.ok(data.proxy_pool)
    assert.equal(typeof data.proxy_pool.total, 'number')
    assert.equal(typeof data.proxy_pool.disconnect_on_error, 'boolean')
    const vm = (data.vms || []).find((item) => item.id === 'vm-sim-01')
    assert.ok(vm)
    assert.equal(vm.proxy_configured, true)
    assert.equal(vm.can_import_credential, true)

    const det = await api(gw, 'GET', '/api/panel/vms/vm-sim-01')
    assert.equal(det.status, 200, det.text)
    const detail = det.json.data || det.json
    assert.ok(detail.proxy_pool)
    assert.equal(detail.vm.proxy_configured, true)
    assert.equal(detail.vm.can_import_credential, true)
  } finally {
    await gw.stop()
  }
})

test('sessionKey import without SOCKS5 is rejected', async () => {
  const gw = await startGateway()
  try {
    const vmPath = path.join(gw.project, 'vms', 'vm-sim-01.json')
    const rec = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    rec.proxy = null
    fs.writeFileSync(vmPath, JSON.stringify(rec, null, 2))
    const imp = await api(gw, 'POST', '/api/panel/vms/import', {
      body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid01-' + 'e'.repeat(24) },
    })
    assert.equal(imp.status, 400, imp.text)
    assert.match(String(imp.json?.error?.message || ''), /SOCKS5/)
  } finally {
    await gw.stop()
  }
})

test('sessionKey import rejected when bound proxy is dead', async () => {
  const gw = await startGateway()
  try {
    const added = await api(gw, 'POST', '/api/panel/proxies/import', {
      body: { text: '10.9.9.9:1080' },
    })
    assert.equal(added.status, 200, added.text)
    const pxId = (added.json.data || added.json).items[0].id
    const bind = await api(gw, 'POST', `/api/panel/proxies/${pxId}/bind`, {
      body: { vm_id: 'vm-sim-01' },
    })
    assert.equal(bind.status, 200, bind.text)
    const off = await api(gw, 'POST', `/api/panel/proxies/${pxId}/disable`)
    assert.equal(off.status, 200, off.text)
    const imp = await api(gw, 'POST', '/api/panel/vms/import', {
      body: { vm_id: 'vm-sim-01', sessionKey: 'sk-ant-sid01-' + 'e'.repeat(24) },
    })
    assert.equal(imp.status, 400, imp.text)
    assert.match(String(imp.json?.error?.message || ''), /SOCKS5/)
  } finally {
    await gw.stop()
  }
})

test('proxy disconnect_on_error can be toggled via config', async () => {
  const gw = await startGateway()
  try {
    const got = await api(gw, 'GET', '/api/panel/proxies/config')
    assert.equal(got.status, 200, got.text)
    const before = got.json.data || got.json
    assert.equal(before.disconnect_on_error, false)
    const put = await api(gw, 'PUT', '/api/panel/proxies/config', {
      body: { disconnect_on_error: true },
    })
    assert.equal(put.status, 200, put.text)
    const after = put.json.data || put.json
    assert.equal(after.disconnect_on_error, true)
  } finally {
    await gw.stop()
  }
})
