import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

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
        expires_at: Math.floor(Date.now() / 1000) + 3600,
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
    accountQuota: extras.accountQuota || { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
}

test('scheduler skips a slot whose access token is known expired', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm1 = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
  vm1.claude.expires_at = Math.floor(Date.now() / 1000) - 3600
  fs.writeFileSync(path.join(root, 'vms', 'vm-01.json'), JSON.stringify(vm1))
  const pool = scheduler(root)
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

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

test('soft-paused but schedulable account stays eligible', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.status = 'paused'
  vm.schedulable = true
  fs.writeFileSync(file, JSON.stringify(vm))
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-1')
  selected.release()
})

test('stopped slot stays ineligible even if schedulable was left true', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.status = 'stopped'
    vm.schedulable = true
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'no_eligible_accounts')
})

test('cooldown is waitable and becomes selectable after it expires', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 200, sticky_wait_timeout_ms: 200 },
  })
  pool.markCooldown({
    accountId: 'account-1',
    vmId: 'vm-01',
  }, {
    until: Date.now() + 40,
    reason: 'provider_transient_error',
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.accountId, 'account-1')
  assert.ok(selected.waitMs >= 30)
  selected.release()
})

test('busy slot waits for release instead of failing closed', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 1
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 200, sticky_wait_timeout_ms: 200 },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(first.ok, true)
  const pending = pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: true,
  })
  setTimeout(() => first.release(), 30)
  const second = await pending
  assert.equal(second.ok, true)
  assert.equal(second.accountId, 'account-1')
  second.release()
})

test('wait timeout on cooldown returns busy rather than empty pool', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: repo,
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fallback_wait_timeout_ms: 20, sticky_wait_timeout_ms: 20 },
  })
  repo.markCooldown('account-1', { vmId: 'vm-01', until: Date.now() + 60_000, reason: 'provider_transient_error' })
  repo.markCooldown('account-2', { vmId: 'vm-02', until: Date.now() + 60_000, reason: 'provider_transient_error' })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    allowWait: true,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'all_accounts_busy')
})

test('fable family cooldown still allows sonnet on the same account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = new RuntimeRepo()
  const pool = scheduler(root, { runtimeRepo: repo })
  pool.markCooldown({
    accountId: 'account-1',
    vmId: 'vm-01',
  }, {
    model: 'fable',
    until: Date.now() + 60_000,
    reason: 'fable_timeout',
  })
  const fable = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(fable.ok, false)
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, true)
  assert.equal(sonnet.accountId, 'account-1')
  sonnet.release()
})

test('fable concurrency cap leaves room for other models', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 8
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async () => ({ ok: true, credential: { generation: 1, has_access: true } }),
    config: { fable_max_per_account: 1, fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const first = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(first.ok, true)
  const second = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(second.ok, false)
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, true)
  first.release()
  sonnet.release()
})

test('weekly split blocks regular but still accepts fable on the same account', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const split = {
    enabled: true,
    fable_share: 0.5,
    fable_used_weekly: 0,
    regular_used_weekly: 0.5,
    fable_remain_weekly: 0.5,
    regular_remain_weekly: 0,
    fable_blocked: false,
    regular_blocked: true,
    mode: 'fable_only',
  }
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      weeklySplitOf: () => split,
    },
  })
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, false)
  assert.equal(sonnet.reason, 'all_accounts_busy')
  const fable = await pool.selectAndReserve({
    model: 'claude-fable-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(fable.ok, true)
  assert.equal(fable.accountId, 'account-1')
  fable.release()
})

test('weekly split disabled never intercepts even if halves look full', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = scheduler(root, {
    accountQuota: {
      canAccept: () => ({ ok: true }),
      weeklySplitOf: () => ({
        enabled: false,
        regular_blocked: true,
        fable_blocked: true,
        mode: 'open',
      }),
    },
  })
  const sonnet = await pool.selectAndReserve({
    model: 'claude-sonnet-5',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(sonnet.ok, true)
  assert.equal(sonnet.accountId, 'account-1')
  sonnet.release()
})

test('scheduler skips a slot with no Claude token', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.claude = {}
  fs.writeFileSync(file, JSON.stringify(vm))
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('scheduler hard-excludes worker refresh failure', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = new PoolScheduler({
    projectRoot: root,
    runtimeRepo: new RuntimeRepo(),
    accountQuota: { canAccept: () => ({ ok: true }) },
    workerHealth: async (exec) => exec.vmId === 'vm-01'
      ? { ok: false, last_error: 'credential_refresh_failed' }
      : { ok: true, credential: { generation: 1, has_access: true } },
    config: { fallback_wait_timeout_ms: 5, sticky_wait_timeout_ms: 5 },
  })
  const selected = await pool.selectAndReserve({ model: 'claude-test', allowWait: false })
  assert.equal(selected.ok, true)
  assert.equal(selected.vmId, 'vm-02')
  selected.release()
})

test('maxConcurrency 0 does not fall back to 20', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02']) {
    const file = path.join(root, 'vms', `${id}.json`)
    const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
    vm.policy.maxConcurrency = 0
    fs.writeFileSync(file, JSON.stringify(vm))
  }
  const selected = await scheduler(root).selectAndReserve({
    model: 'claude-test',
    allowWait: false,
  })
  assert.equal(selected.ok, false)
  assert.equal(selected.reason, 'no_eligible_accounts')
})

test('maxConcurrency 8 is the actual reserve cap', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'vms', 'vm-01.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.policy.maxConcurrency = 8
  fs.writeFileSync(file, JSON.stringify(vm))
  const pool = scheduler(root)
  const held = []
  for (let i = 0; i < 8; i++) {
    const selected = await pool.selectAndReserve({
      model: 'claude-test',
      excluded: new Set(['account-2']),
      allowWait: false,
    })
    assert.equal(selected.ok, true)
    held.push(selected)
  }
  const ninth = await pool.selectAndReserve({
    model: 'claude-test',
    excluded: new Set(['account-2']),
    allowWait: false,
  })
  assert.equal(ninth.ok, false)
  for (const item of held) item.release()
})

test('dead sticky binding is unbound then WRR continues', async (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const unbound = []
  const pool = scheduler(root, {
    stickyRouter: {
      resolve: () => ({ vmId: 'vm-gone', accountId: 'account-gone' }),
      unbind: (key) => unbound.push(key),
    },
  })
  const selected = await pool.selectAndReserve({
    model: 'claude-test',
    stickyKey: 'stale-session',
    allowWait: false,
  })
  assert.equal(selected.ok, true)
  assert.deepEqual(unbound, ['stale-session'])
  assert.notEqual(selected.selectionReason, 'sticky')
  selected.release()
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
