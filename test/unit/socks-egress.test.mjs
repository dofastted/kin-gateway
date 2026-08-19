import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNatOutputSave,
  planUidSocksExemption,
  parseSocksEndpoint,
  socksEndpointFromVm,
  ensureUidSocksExemption,
  LOOPBACK_CIDR,
} from '../../src/lib/vm/socks-egress.mjs'

const UID = '10001'
const SOCKS_HOST = '130.180.236.62'
const SOCKS_PORT = 6067

const HIJACK_ONLY = `
-P OUTPUT ACCEPT
-A OUTPUT -m owner --uid-owner 10001 -d 127.0.0.0/8 -p tcp -j RETURN
-A OUTPUT -m owner --uid-owner 10001 -p tcp -j REDIRECT --to-ports 12345
`.trim()

const SPLIT = `
-P OUTPUT ACCEPT
-A OUTPUT -m owner --uid-owner 10001 -d 127.0.0.0/8 -p tcp -j RETURN
-A OUTPUT -m owner --uid-owner 10001 -p tcp -d 130.180.236.62/32 --dport 6067 -j RETURN
-A OUTPUT -m owner --uid-owner 10001 -p tcp -j REDIRECT --to-ports 12345
`.trim()

const MISORDERED = `
-P OUTPUT ACCEPT
-A OUTPUT -m owner --uid-owner 10001 -d 127.0.0.0/8 -p tcp -j RETURN
-A OUTPUT -m owner --uid-owner 10001 -p tcp -j REDIRECT --to-ports 12345
-A OUTPUT -m owner --uid-owner 10001 -p tcp -d 130.180.236.62/32 --dport 6067 -j RETURN
`.trim()

test('parseSocksEndpoint keeps host:port and drops credentials', () => {
  assert.deepEqual(
    parseSocksEndpoint('socks5h://user:pass@130.180.236.62:6067'),
    { host: '130.180.236.62', port: 6067 },
  )
  assert.deepEqual(
    socksEndpointFromVm({
      proxy_cli_enabled: true,
      proxy: { host: SOCKS_HOST, port: SOCKS_PORT },
    }),
    { host: SOCKS_HOST, port: SOCKS_PORT },
  )
  assert.equal(socksEndpointFromVm({ proxy: { host: SOCKS_HOST, port: SOCKS_PORT } }), null)
})

test('uid REDIRECT without SOCKS RETURN inserts exemption before gost', () => {
  const plan = planUidSocksExemption({
    uid: UID,
    host: SOCKS_HOST,
    port: SOCKS_PORT,
    rules: parseNatOutputSave(HIJACK_ONLY),
  })
  assert.equal(plan.needed, true)
  assert.equal(plan.reason, 'insert_socks_return')
  assert.equal(plan.actions.length, 1)
  assert.deepEqual(plan.actions[0].argv, [
    '-t', 'nat', '-I', 'OUTPUT', '2',
    '-m', 'owner', '--uid-owner', UID,
    '-p', 'tcp', '-d', SOCKS_HOST,
    '-m', 'tcp', '--dport', String(SOCKS_PORT),
    '-m', 'comment', '--comment', 'kin-socks-exempt:10001',
    '-j', 'RETURN',
  ])
})

test('already-split rules are a no-op', () => {
  const plan = planUidSocksExemption({
    uid: UID,
    host: SOCKS_HOST,
    port: SOCKS_PORT,
    rules: parseNatOutputSave(SPLIT),
  })
  assert.equal(plan.needed, false)
  assert.equal(plan.reason, 'already_exempt')
  assert.deepEqual(plan.actions, [])
})

test('SOCKS RETURN after REDIRECT is deleted and reinserted in front', () => {
  const plan = planUidSocksExemption({
    uid: UID,
    host: SOCKS_HOST,
    port: SOCKS_PORT,
    rules: parseNatOutputSave(MISORDERED),
  })
  assert.equal(plan.reason, 'reorder_socks_return')
  assert.equal(plan.actions[0].type, 'delete')
  assert.equal(plan.actions[0].argv[2], '-D')
  assert.equal(plan.actions[1].type, 'insert')
  assert.equal(plan.actions[1].argv[4], '2')
})

test('no uid REDIRECT means the worker SOCKS path is left alone', () => {
  const plan = planUidSocksExemption({
    uid: UID,
    host: SOCKS_HOST,
    port: SOCKS_PORT,
    rules: parseNatOutputSave('-P OUTPUT ACCEPT'),
  })
  assert.equal(plan.needed, false)
  assert.equal(plan.reason, 'no_uid_redirect')
})

test('loopback SOCKS is covered by the existing 127.0.0.0/8 RETURN', () => {
  const plan = planUidSocksExemption({
    uid: UID,
    host: '127.0.0.1',
    port: 19080,
    rules: parseNatOutputSave(HIJACK_ONLY),
  })
  assert.equal(plan.needed, false)
  assert.equal(plan.reason, 'loopback_covers_socks')
})

test('missing loopback RETURN is repaired in front of REDIRECT', () => {
  const plan = planUidSocksExemption({
    uid: UID,
    host: SOCKS_HOST,
    port: SOCKS_PORT,
    rules: parseNatOutputSave('-A OUTPUT -m owner --uid-owner 10001 -p tcp -j REDIRECT --to-ports 12345'),
  })
  assert.equal(plan.actions[0].argv.includes(LOOPBACK_CIDR), true)
  assert.equal(plan.actions[1].argv.includes(SOCKS_HOST), true)
})

test('ensureUidSocksExemption applies the insert via iptables and rechecks', () => {
  let save = HIJACK_ONLY
  const run = (argv) => {
    if (argv[0] === 'iptables' && argv.includes('-S')) {
      return { ok: true, stdout: save, stderr: '' }
    }
    if (argv.includes('-I') && argv.includes(SOCKS_HOST)) {
      save = SPLIT
      return { ok: true, stdout: '', stderr: '' }
    }
    return { ok: false, stdout: '', stderr: `unexpected ${argv.join(' ')}` }
  }
  const result = ensureUidSocksExemption({ uid: UID, host: SOCKS_HOST, port: SOCKS_PORT, run })
  assert.equal(result.ok, true)
  assert.equal(result.applied, true)
  assert.equal(result.host, SOCKS_HOST)
})

test('ensureUidSocksExemption fails closed when a hijack exists and insert is denied', () => {
  const run = (argv) => {
    if (argv.includes('-S')) return { ok: true, stdout: HIJACK_ONLY, stderr: '' }
    return { ok: false, stdout: '', stderr: 'iptables: Permission denied' }
  }
  const result = ensureUidSocksExemption({ uid: UID, host: SOCKS_HOST, port: SOCKS_PORT, run })
  assert.equal(result.ok, false)
  assert.match(result.error, /Permission denied|exemption failed/)
})

test('ensureUidSocksExemption no-ops when iptables is missing', () => {
  const run = () => ({ ok: false, stdout: '', stderr: 'iptables: not found' })
  const result = ensureUidSocksExemption({ uid: UID, host: SOCKS_HOST, port: SOCKS_PORT, run })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'iptables_unavailable')
})

test('ensureOuterSocks fail-closes when uid REDIRECT cannot be exempted', async () => {
  const { ensureOuterSocks } = await import('../../src/lib/vm/vm-runtime.mjs')
  const vm = {
    id: 'vm-01',
    proxy_cli_enabled: true,
    proxy: { host: SOCKS_HOST, port: SOCKS_PORT },
  }
  const run = (argv) => {
    if (argv.includes('-S')) return { ok: true, stdout: HIJACK_ONLY, stderr: '' }
    return { ok: false, stdout: '', stderr: 'iptables: Permission denied' }
  }
  const result = ensureOuterSocks(vm, { run })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /Permission denied|exemption failed/)
})
