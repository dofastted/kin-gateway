import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDashboard, buildVmDetail, summarizeProxyPool } from '../../src/lib/admin/panel-api.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function tmpDir(prefix = 'kin-panel-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeQuota() {
  return {
    config: { safety_ratio: 0.95 },
    snapshot: () => ({ accounts: [], safety_ratio: 0.95 }),
  }
}

function writeVm(project, rec) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2))
}

test('summarizeProxyPool includes disconnect_on_error', () => {
  assert.deepEqual(summarizeProxyPool(null), {
    total: 0, free: 0, bound: 0, ok: 0, dead: 0, probing: false, disconnect_on_error: false,
  })
  const dir = tmpDir()
  const pool = new ProxyPool({ dataDir: dir })
  pool.importLines('10.0.0.9:1080')
  pool.updateConfig({ disconnect_on_error: true })
  pool.stopScheduler()
  const sum = summarizeProxyPool(pool)
  assert.equal(sum.total, 1)
  assert.equal(sum.free, 1)
  assert.equal(sum.disconnect_on_error, true)
})

test('dashboard and vm detail merge pool health onto bound VM', () => {
  const project = tmpDir()
  const dataDir = path.join(project, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  writeVm(project, {
    id: 'vm-02',
    name: '02',
    status: 'stopped',
    proxy_cli_enabled: true,
    proxy: { id: 'px-will-replace', host: '10.9.9.9', port: 1080, scheme: 'socks5', url: 'socks5://10.9.9.9:1080' },
    claude: {},
    policy: { maxConcurrency: 4, weight: 1 },
  })
  const pool = new ProxyPool({ dataDir })
  pool.importLines('10.8.8.8:1080')
  const px = pool.snapshot().proxies[0]
  pool.bind(px.id, 'vm-02')
  const bound = pool.state.proxies[0]
  bound.status = 'ok'
  bound.latency_ms = 12
  bound.last_probe_at = '2026-01-01T00:00:00Z'
  pool.save()
  pool.stopScheduler()

  const cfg = { paths: { project }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const quota = fakeQuota()
  const dash = buildDashboard({
    cfg,
    accountQuota: quota,
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
    routingConfig: { sticky: { enabled: true }, quota: { safety_ratio: 0.95 } },
    stats: {},
    proxyPool: pool,
  })
  assert.equal(dash.ok, true)
  assert.equal(dash.data.proxy_pool.total, 1)
  assert.equal(dash.data.proxy_pool.bound, 1)
  const vm = dash.data.vms.find((item) => item.id === 'vm-02')
  assert.equal(vm.proxy_configured, true)
  assert.equal(vm.can_import_credential, true)
  assert.equal(vm.proxy.status, 'ok')
  assert.equal(vm.proxy.latency_ms, 12)
  assert.equal(vm.proxy.host, '10.8.8.8')

  const detail = buildVmDetail({ cfg, accountQuota: quota, id: 'vm-02', proxyPool: pool })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.vm.proxy_configured, true)
  assert.equal(detail.data.proxy.status, 'ok')
  assert.equal(detail.data.proxy_pool.bound, 1)
})

test('dead bound proxy blocks credential import', () => {
  const project = tmpDir()
  const dataDir = path.join(project, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  writeVm(project, {
    id: 'vm-03',
    name: '03',
    status: 'stopped',
    proxy: { id: 'px-dead', host: '10.7.7.7', port: 1080, url: 'socks5://10.7.7.7:1080' },
    claude: {},
    policy: {},
  })
  const pool = new ProxyPool({ dataDir })
  pool.importLines('10.7.7.7:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-03')
  pool.setEnabled(id, false)
  pool.stopScheduler()
  const cfg = { paths: { project }, rewrite: {}, base_url: '' }
  const detail = buildVmDetail({ cfg, accountQuota: fakeQuota(), id: 'vm-03', proxyPool: pool })
  assert.equal(detail.data.vm.proxy_configured, true)
  assert.equal(detail.data.vm.can_import_credential, false)
  assert.equal(detail.data.vm.proxy.status, 'dead')
})
