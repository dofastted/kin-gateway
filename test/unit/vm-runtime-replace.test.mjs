import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shouldReplaceSlotContainer,
  proxyEndpointFromUrl,
  proxyEndpointFromVm,
  readWorkerProxyEndpoint,
  isSlotProxyDesynced,
} from '../../src/lib/vm/vm-runtime.mjs'

const running = { running: true, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }
const stopped = { running: false, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }

test('running slot is never replaced unless recreate is explicit', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: running, recreate: false, network: 'bridge', image: 'other' }), false)
  assert.equal(shouldReplaceSlotContainer({ existing: running, recreate: true, network: 'host', image: running.image }), true)
})

test('stopped slot is replaced only when net or image is wrong', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: stopped.image }), false)
  assert.equal(shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'bridge', image: stopped.image }), true)
  assert.equal(shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: 'other' }), true)
})

test('missing container is not replaced', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: null, recreate: true }), false)
})

test('proxyEndpoint strips userinfo', () => {
  assert.equal(proxyEndpointFromUrl('socks5h://user:pass@72.1.181.43:5437'), '72.1.181.43:5437')
  assert.equal(proxyEndpointFromVm({ proxy: { host: '72.1.181.43', port: 5437 } }), '72.1.181.43:5437')
})

test('isSlotProxyDesynced compares worker.json to vm.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proxy-sync-'))
  const vm = { id: 'vm-02', proxy: { host: '72.1.181.43', port: 5437, url: 'socks5://u:p@72.1.181.43:5437' } }
  fs.mkdirSync(path.join(root, 'vms', 'vm-02', 'run'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-02', 'run', 'worker.json'), JSON.stringify({
    proxy_url: 'socks5h://old:pass@154.9.177.229:5509',
  }))
  assert.equal(readWorkerProxyEndpoint(root, 'vm-02'), '154.9.177.229:5509')
  assert.equal(isSlotProxyDesynced(vm, root), true)
  fs.writeFileSync(path.join(root, 'vms', 'vm-02', 'run', 'worker.json'), JSON.stringify({
    proxy_url: 'socks5h://u:p@72.1.181.43:5437',
  }))
  assert.equal(isSlotProxyDesynced(vm, root), false)
  fs.rmSync(root, { recursive: true, force: true })
})
