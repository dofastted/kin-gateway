import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool-scheduler.mjs'

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pool-scheduler-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  const write = (id, accountId, policy = {}) => {
    const vm = {
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: `socks5h://127.0.0.1:${id === 'vm-01' ? 10001 : 10002}` },
      runtime: { worker_socket: path.join(vms, id, 'run', 'worker.sock') },
      policy: { maxConcurrency: 2, weight: 1, priority: 0, ...policy },
      claude: {
        account_uuid: accountId,
        access_token: `access-${accountId}`,
        refresh_token: `refresh-${accountId}`,
      },
    }
    fs.writeFileSync(path.join(vms, `${id}.json`), JSON.stringify(vm))
    return vm
  }
  write('vm-01', 'account-1')
  write('vm-02', 'account-2')
  fs.writeFileSync(path.join(vms, 'active.json'), JSON.stringify({ active_vm: 'vm-01' }))
  return root
}

class RuntimeRepo {
  states = new Map()

  get(id) { return this.states.get(id) || null }
  clearExpired() {}
  upsert(state) {
    const next = { ...(this.states.get(state.account_id) || {}), ...state }
    this.states.set(state.account_id, next)
    return next
  }
  markCooldown(id, update) {
    const state = this.states.get(id) || { account_id: id, vm_id: update.vmId, model_states: {} }
    if (update.model) {
      state.model_states = {
        ...(state.model_states || {}),
        [update.model]: { cooldown_until: update.until, reason: update.reason },
      }
    } else {
      state.cooldown_until = update.until
      state.cooldown_reason = update.reason
      state.status = update.status
    }
    this.states.set(id, state)
    return state
  }
}

function scheduler(root, extras = {}) {
  return new PoolScheduler({
    projectRoot: root,
    runtimeRepo: extras.runtimeRepo || new RuntimeRepo(),
    stickyRouter: extras.stickyRouter || null,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1 } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
}

test('scheduler skips excluded account and reserves the next one', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-1']),
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-2')
  assert.equal(pool.snapshot().inflight['account-2'], 1)
  selected.release()
  assert.equal(pool.snapshot().inflight['account-2'], undefined)
})

test('healthy sticky binding outranks weighted selection', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-02', accountId: 'account-2' }),
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'conversation-1',
    allowWait: false,
  })
  assert.equal(selected.accountId, 'account-2')
  assert.equal(selected.selectionReason, 'sticky')
  selected.release()
})

test('account and model cooldowns remove only affected candidates', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = scheduler(root, { runtimeRepo: repo })
  pool.markCooldown({
    accountId: 'account-1',
    vmId: 'vm-01',
  }, {
    model: 'claude-opus',
    until: Date.now() + 60_000,
    reason: 'model_rate_limit',
  })
  let selected = await pool.selectAndReserve({
    model: 'claude-opus',
    allowWait: false,
  })
  assert.equal(selected.accountId, 'account-2')
  selected.release()
  selected = await pool.selectAndReserve({
    model: 'claude-sonnet',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  selected.release()
})

test('weighted round robin distributes equal-load candidates', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root)
  const counts = { 'account-1': 0, 'account-2': 0 }
  for (let i = 0; i < 10; i++) {
    const selected = await pool.selectAndReserve({
      model: 'claude-test',
      allowWait: false,
    })
    counts[selected.accountId]++
    selected.release()
  }
  assert.deepEqual(counts, { 'account-1': 5, 'account-2': 5 })
})

test('scheduler fails closed when every account is ineligible', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file))
    vm.schedulable = false
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'no_eligible_accounts')
})
