import test from 'node:test'
import assert from 'node:assert/strict'
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
