import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function tmpDir(prefix = 'kin-sticky-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('bind + resolve + hits increment', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-1', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'sess-9' })
  const hit = r.resolve('conv-1')
  assert.equal(hit.accountId, 'acc-1')
  assert.equal(hit.vmId, 'vm-1')
  assert.equal(hit.sessionId, 'sess-9')
  r.bind('conv-1', { accountId: 'acc-1', vmId: 'vm-1' })
  assert.equal(r.stats().sessions['conv-1'].hits, 2)
  // session_id preserved from previous bind
  assert.equal(r.stats().sessions['conv-1'].session_id, 'sess-9')
})

test('expired sessions purge on resolve/stats', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: -1 } } })
  r.bind('conv-2', { accountId: 'a', vmId: 'v' })
  assert.equal(r.resolve('conv-2'), null)
  assert.equal(r.stats().active_sessions, 0)
})

test('disabled sticky returns null and binds nothing', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: false } } })
  r.bind('conv-3', { accountId: 'a', vmId: 'v' })
  assert.equal(r.resolve('conv-3'), null)
})

test('sticky sessions persist across re-open', () => {
  const dir = tmpDir()
  const cfg = { sticky: { enabled: true, ttl_seconds: 3600 } }
  const r1 = new StickyRouter({ dataDir: dir, config: cfg })
  r1.bind('conv-4', { accountId: 'acc-4', vmId: 'vm-4' })

  const r2 = new StickyRouter({ dataDir: dir, config: cfg })
  const hit = r2.resolve('conv-4')
  assert.ok(hit)
  assert.equal(hit.accountId, 'acc-4')
})

test('proxy pool import/bind/config persist across re-open', () => {
  const dir = tmpDir('kin-proxy-')
  const pool = new ProxyPool({ dataDir: dir })
  const res = pool.importLines('socks5://user:pass@10.0.0.1:1080\n10.0.0.2:1080\nbadline:xx\n10.0.0.1:1080:user:pass')
  assert.equal(res.added, 2)
  const id = pool.snapshot().proxies[0].id
  assert.equal(pool.bind(id, 'vm-1').ok, true)
  pool.updateConfig({ probe_interval_min: 30, max_failures: 3 })
  pool.stopScheduler()

  const pool2 = new ProxyPool({ dataDir: dir })
  const snap = pool2.snapshot()
  assert.equal(snap.totals.total, 2)
  assert.equal(snap.config.probe_interval_min, 30)
  assert.equal(snap.config.max_failures, 3)
  assert.equal(snap.proxies.find((p) => p.id === id).bound_vm_id, 'vm-1')
  const forVm = pool2.getProxyForVm('vm-1')
  assert.equal(forVm.url, 'socks5://user:pass@10.0.0.1:1080')
  pool2.stopScheduler()
})

test('proxy remove + unbindVm persist', () => {
  const dir = tmpDir('kin-proxy-')
  const pool = new ProxyPool({ dataDir: dir })
  pool.importLines('10.1.1.1:1080\n10.1.1.2:1080')
  const [a, b] = pool.snapshot().proxies.map((p) => p.id)
  pool.bind(a, 'vm-z')
  pool.unbindVm('vm-z')
  pool.remove(b)
  pool.stopScheduler()

  const pool2 = new ProxyPool({ dataDir: dir })
  const snap = pool2.snapshot()
  assert.equal(snap.totals.total, 1)
  assert.equal(snap.proxies[0].bound_vm_id, null)
  pool2.stopScheduler()
})

test('disconnect_on_error config persists and runtime failure disables slot', () => {
  const dir = tmpDir('kin-proxy-')
  const disabled = []
  const disconnected = []
  const pool = new ProxyPool({
    dataDir: dir,
    onDisableVm: (vmId, reason, proxyId) => disabled.push({ vmId, reason, proxyId }),
    onDisconnectVm: (vmId, reason, proxyId) => disconnected.push({ vmId, reason, proxyId }),
  })
  pool.importLines('10.2.2.2:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-err')
  assert.equal(pool.snapshot().config.disconnect_on_error, false)
  const skipped = pool.reportRuntimeFailure('vm-err', 'proxy_transport_failure')
  assert.equal(skipped.skipped, true)
  assert.equal(disconnected.length, 0)

  const updated = pool.updateConfig({ disconnect_on_error: true, max_failures: 1 })
  assert.equal(updated.ok, true)
  assert.equal(updated.config.disconnect_on_error, true)
  pool.stopScheduler()

  const pool2 = new ProxyPool({
    dataDir: dir,
    onDisableVm: (vmId, reason, proxyId) => disabled.push({ vmId, reason, proxyId }),
    onDisconnectVm: (vmId, reason, proxyId) => disconnected.push({ vmId, reason, proxyId }),
  })
  assert.equal(pool2.snapshot().config.disconnect_on_error, true)
  const reported = pool2.reportRuntimeFailure('vm-err', 'proxy_transport_failure')
  assert.equal(reported.ok, true)
  assert.equal(reported.skipped, false)
  assert.equal(reported.proxy.status, 'dead')
  assert.equal(disconnected.length, 1)
  assert.equal(disconnected[0].vmId, 'vm-err')
  assert.match(disconnected[0].reason, /proxy_disconnect/)
  assert.equal(disabled.length, 0, 'runtime disconnect should not also fire probe disable')
  pool2.stopScheduler()
})
