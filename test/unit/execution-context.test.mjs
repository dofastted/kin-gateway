import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  pickSchedulableVmId,
  resolveVmProxyUrl,
  GATEWAY_CAPABILITIES,
  snapshotOauth,
} from '../../src/lib/vm/execution-context.mjs'

function writeVm(root, id, patch = {}) {
  const vm = {
    id,
    name: id,
    status: 'running',
    schedulable: true,
    kernel: 'unikernel-min',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    seed_policy: { reject_client_settings: true },
    policy: { maxConcurrency: 2 },
    proxy_cli_enabled: true,
    proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
    claude: {
      access_token: `at-${id}`,
      refresh_token: `rt-${id}`,
      expires_at: 1999999999,
      email: `${id}@ex.test`,
      account_uuid: `acct-${id}`,
    },
    ...patch,
  }
  if (patch.claude) vm.claude = { ...vm.claude, ...patch.claude }
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm, null, 2))
  return vm
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-exec-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  writeVm(root, 'vm-01')
  writeVm(root, 'vm-02', { claude: { access_token: 'at-vm-02', account_uuid: 'acct-vm-02' } })
  writeVm(root, 'vm-03', { schedulable: false })
  writeVm(root, 'vm-04', { claude: { access_token: null, refresh_token: null, session_key: null } })
  return {
    root,
    cfg: { paths: { project: root }, limits: { upstream_timeout_ms: 120000 } },
  }
}

test('capabilities are honest: CRS default, client tools, docker runtime', () => {
  assert.equal(GATEWAY_CAPABILITIES.client_tools, true)
  assert.equal(GATEWAY_CAPABILITIES.images, true)
  assert.equal(GATEWAY_CAPABILITIES.tool_execution, 'client')
  assert.equal(GATEWAY_CAPABILITIES.workspace_default, 'client')
  assert.equal(GATEWAY_CAPABILITIES.forward_default, 'relay')
  assert.equal(GATEWAY_CAPABILITIES.multi_turn_native, true)
  assert.equal(GATEWAY_CAPABILITIES.claude_session, false)
  assert.equal(GATEWAY_CAPABILITIES.kernel, 'mixed-os-docker')
  assert.equal(GATEWAY_CAPABILITIES.runtime, 'docker-container')
})

test('pickSchedulableVmId prefers sticky then active, skips unschedulable / no-token', () => {
  const { root } = fixture()
  assert.equal(pickSchedulableVmId(root, 'vm-02'), 'vm-02')
  assert.equal(pickSchedulableVmId(root, 'vm-03'), 'vm-01')
  assert.equal(pickSchedulableVmId(root, 'vm-04'), 'vm-01')
  assert.equal(pickSchedulableVmId(root, null), 'vm-01')
})

test('resolveVmProxyUrl stays off unless proxy_cli_enabled', () => {
  assert.equal(resolveVmProxyUrl({ proxy: { host: '10.0.0.1', port: 1080 } }), null)
  assert.equal(resolveVmProxyUrl({
    proxy_cli_enabled: true,
    proxy: { host: '10.0.0.1', port: 1080, username: 'u', password: 'p' },
  }), 'socks5h://u:p@10.0.0.1:1080')
})

test('snapshotOauth reads the scheduled record only', () => {
  const s = snapshotOauth({
    claude: { access_token: 'x', email: 'a@b.c', org_uuid: 'org' },
  })
  assert.equal(s.access_token, 'x')
  assert.equal(s.email, 'a@b.c')
  assert.equal(s.org_uuid, 'org')
})
