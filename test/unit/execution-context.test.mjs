import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  pickSchedulableVmId,
  buildExecutionContext,
  buildCliOptsFromExec,
  resolveVmProxyUrl,
  GATEWAY_CAPABILITIES,
  snapshotOauth,
} from '../../src/lib/execution-context.mjs'

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
  writeVm(root, 'vm-04', { claude: { access_token: null, session_key: null } })
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
  assert.equal(GATEWAY_CAPABILITIES.multi_turn_native, false)
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

test('buildExecutionContext does not read a process-global vm', () => {
  const { cfg } = fixture()
  const stickyRouter = {
    extractKey: () => 'conv-1',
    resolve: () => ({ accountId: 'acct-vm-02', vmId: 'vm-02' }),
  }
  const built = buildExecutionContext({
    cfg,
    inbound: { model: 'claude-haiku-4-5-20251001' },
    req: { headers: {} },
    protocol: 'anthropic.messages',
    pathName: '/v1/messages',
    stickyRouter,
  })
  assert.equal(built.ok, true)
  assert.equal(built.exec.vmId, 'vm-02')
  assert.equal(built.exec.accountId, 'acct-vm-02')
  assert.equal(built.exec.oauth.access_token, 'at-vm-02')
  assert.match(built.exec.homeDir, /vms\/vm-02\/cli-home$/)
  assert.equal(built.exec.proxyUrl, null)

  const opts = buildCliOptsFromExec(built.exec, { model: 'claude-haiku-4-5-20251001' })
  assert.equal(opts.accessToken, 'at-vm-02')
  assert.equal(opts.homeDir, built.exec.homeDir)
  assert.equal(opts.timezone, 'America/Los_Angeles')
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
