import { getVm, listVms } from '../vm/vm-registry.mjs'
import { vmCliHomePath, vmJsonPath } from '../vm/execution-context.mjs'

const DEFAULT_CONFIG = {
  strategy: 'weighted-round-robin',
  max_waiters_per_account: 32,
  fallback_wait_timeout_ms: 5000,
  sticky_wait_timeout_ms: 15000,
  worker_health_ttl_ms: 5000,
  heartbeat_stale_ms: 15000,
}

function accountIdOf(vm) {
  return vm?.claude?.account_uuid || vm?.id || null
}

function maxConcurrencyOf(vm) {
  return Math.max(1, Number(vm?.policy?.maxConcurrency) || 20)
}

function priorityOf(vm, state) {
  return Number(vm?.policy?.priority ?? state?.priority ?? 0) || 0
}

function weightOf(vm, state) {
  return Math.max(0, Number(vm?.policy?.weight ?? state?.weight ?? 1) || 0)
}

function cooldownActive(until, now) {
  return Number(until) > now
}

function normalizeModel(model) {
  return String(model || '').trim().toLowerCase()
}

function makeAbortError(message = 'Selection cancelled') {
  return Object.assign(new Error(message), { code: 'selection_cancelled' })
}

export class PoolScheduler {
  constructor({
    projectRoot,
    stickyRouter = null,
    accountQuota = null,
    runtimeRepo = null,
    workerHealth = null,
    config = {},
  } = {}) {
    this.projectRoot = projectRoot
    this.stickyRouter = stickyRouter
    this.accountQuota = accountQuota
    this.runtimeRepo = runtimeRepo
    this.workerHealth = workerHealth
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) }
    this.inflight = new Map()
    this.waiters = new Map()
    this.healthCache = new Map()
    this.smooth = new Map()
    this.lastUsed = new Map()
  }

  async selectAndReserve({
    model,
    stickyKey = null,
    excluded = new Set(),
    signal,
    deadline = null,
    allowWait = true,
  } = {}) {
    const startedAt = Date.now()
    const finalDeadline = Number(deadline) || (
      startedAt + (stickyKey
        ? this.config.sticky_wait_timeout_ms
        : this.config.fallback_wait_timeout_ms)
    )
    for (;;) {
      if (signal?.aborted) throw makeAbortError()
      const candidates = await this.eligibleCandidates({ model, excluded, signal })
      const available = candidates.filter((candidate) => !candidate.busy)
      const selected = this.pick(available, { model, stickyKey })
      if (selected) {
        const reservation = this.reserve(selected)
        if (reservation) {
          return {
            ...selected,
            ...reservation,
            waitMs: Date.now() - startedAt,
          }
        }
        continue
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          code: 'no_available_accounts',
          reason: 'no_eligible_accounts',
          waitMs: Date.now() - startedAt,
        }
      }
      if (!allowWait || Date.now() >= finalDeadline) {
        return {
          ok: false,
          code: 'no_available_accounts',
          reason: candidates.length ? 'all_accounts_busy' : 'no_eligible_accounts',
          waitMs: Date.now() - startedAt,
        }
      }
      await this.waitForCapacity({
        signal,
        deadline: finalDeadline,
        stickyKey,
      })
    }
  }

  async eligibleCandidates({ model, excluded = new Set(), signal } = {}) {
    const now = Date.now()
    this.runtimeRepo?.clearExpired?.(now)
    const summaries = listVms(this.projectRoot)
    const candidates = []
    for (const summary of summaries) {
      if (signal?.aborted) throw makeAbortError()
      const vm = getVm(this.projectRoot, summary.id)
      if (!vm) continue
      const accountId = accountIdOf(vm)
      if (!accountId || excluded.has(accountId) || excluded.has(vm.id)) continue
      const state = this.runtimeRepo?.get?.(accountId) || null
      const eligibility = await this.checkEligibility({ vm, accountId, state, model, now, signal })
      if (!eligibility.ok) continue
      const maxConcurrency = maxConcurrencyOf(vm)
      const inflight = this.inflight.get(accountId) || 0
      candidates.push({
        ok: true,
        vmId: vm.id,
        accountId,
        vm,
        state,
        model: normalizeModel(model),
        priority: priorityOf(vm, state),
        weight: weightOf(vm, state),
        inflight,
        maxConcurrency,
        loadRatio: inflight / maxConcurrency,
        lastUsedAt: this.lastUsed.get(accountId) || state?.last_used_at || 0,
        workerStatus: eligibility.workerStatus,
        busy: !!eligibility.busy,
        exec: this.executionContext(vm, accountId),
      })
    }
    return candidates
  }

  async checkEligibility({ vm, accountId, state, model, now, signal }) {
    if (vm.schedulable === false || vm.status !== 'running') return { ok: false, reason: 'vm_unschedulable' }
    if (!vm.proxy_cli_enabled || !vm.proxy?.url) return { ok: false, reason: 'proxy_required' }
    if (state && cooldownActive(state.cooldown_until, now)) return { ok: false, reason: 'account_cooldown' }
    const modelKey = normalizeModel(model)
    const modelState = state?.model_states?.[modelKey]
    if (modelState && cooldownActive(modelState.cooldown_until, now)) {
      return { ok: false, reason: 'model_cooldown' }
    }
    const inflight = this.inflight.get(accountId) || 0
    let busy = inflight >= maxConcurrencyOf(vm)
    if (this.accountQuota) {
      const gate = this.accountQuota.canAccept(accountId)
      if (!gate.ok) {
        if (gate.reason === 'concurrency_limit') busy = true
        else return { ok: false, reason: gate.reason || 'quota_gate' }
      }
    }
    const workerStatus = await this.getWorkerHealth(this.executionContext(vm, accountId), { signal })
    if (!workerStatus?.ok) return { ok: false, reason: 'worker_unhealthy', workerStatus }
    return { ok: true, workerStatus, busy }
  }

  executionContext(vm, accountId) {
    return {
      vmId: vm.id,
      accountId,
      vm,
      vmPath: vmJsonPath(this.projectRoot, vm.id),
      homeDir: vmCliHomePath(this.projectRoot, vm.id),
      oauth: {
        email: vm.claude?.email || null,
        account_uuid: vm.claude?.account_uuid || null,
        org_uuid: vm.claude?.org_uuid || null,
        expires_at: vm.claude?.expires_at || null,
      },
      proxyUrl: vm.proxy?.url || null,
      timezone: vm.timezone || 'UTC',
      locale: vm.locale || 'en_US.UTF-8',
      kernel: vm.kernel || null,
    }
  }

  async getWorkerHealth(exec, { signal } = {}) {
    if (typeof this.workerHealth !== 'function') {
      return { ok: true, source: 'scheduler-no-health-provider' }
    }
    const now = Date.now()
    const cached = this.healthCache.get(exec.vmId)
    if (cached && now - cached.at < this.config.worker_health_ttl_ms) {
      return cached.value
    }
    let value
    try {
      value = await this.workerHealth(exec, { signal })
    } catch (error) {
      value = { ok: false, error: String(error.message || error) }
    }
    this.healthCache.set(exec.vmId, { at: now, value })
    if (this.runtimeRepo && exec.accountId) {
      this.runtimeRepo.upsert({
        account_id: exec.accountId,
        vm_id: exec.vmId,
        status: value?.ok ? 'ready' : 'worker_unhealthy',
        worker_heartbeat_at: now,
        worker_status: value,
        credential_generation: value?.credential?.generation || 0,
        refresh_status: value?.credential?.needs_refresh ? 'needed' : 'fresh',
      })
    }
    return value
  }

  pick(candidates, { model, stickyKey } = {}) {
    if (!candidates.length) return null
    const bound = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (bound) {
      const sticky = candidates.find((candidate) => (
        candidate.vmId === bound.vmId &&
        candidate.accountId === bound.accountId
      ))
      if (sticky) return { ...sticky, selectionReason: 'sticky' }
    }
    const highestPriority = Math.max(...candidates.map((candidate) => candidate.priority))
    let pool = candidates.filter((candidate) => candidate.priority === highestPriority)
    const minLoad = Math.min(...pool.map((candidate) => candidate.loadRatio))
    pool = pool.filter((candidate) => candidate.loadRatio === minLoad)
    if (pool.length === 1) return { ...pool[0], selectionReason: 'priority-load' }

    const strategy = String(this.config.strategy || 'weighted-round-robin')
    if (strategy === 'fill-first') {
      pool.sort((left, right) => (
        left.lastUsedAt - right.lastUsedAt ||
        left.accountId.localeCompare(right.accountId)
      ))
      return { ...pool[0], selectionReason: 'fill-first' }
    }
    if (strategy === 'round-robin') {
      const key = `rr:${normalizeModel(model)}`
      const cursor = Number(this.smooth.get(key) || 0)
      const sorted = [...pool].sort((left, right) => left.accountId.localeCompare(right.accountId))
      const selected = sorted[cursor % sorted.length]
      this.smooth.set(key, cursor + 1)
      return { ...selected, selectionReason: 'round-robin' }
    }
    return { ...this.pickSmoothWeighted(pool, model), selectionReason: 'weighted-round-robin' }
  }

  pickSmoothWeighted(candidates, model) {
    const key = `wrr:${normalizeModel(model)}`
    let state = this.smooth.get(key)
    if (!state || !(state instanceof Map)) {
      state = new Map()
      this.smooth.set(key, state)
    }
    const active = new Set(candidates.map((candidate) => candidate.accountId))
    for (const id of state.keys()) {
      if (!active.has(id)) state.delete(id)
    }
    let selected = null
    let selectedCurrent = -Infinity
    let total = 0
    for (const candidate of [...candidates].sort((left, right) => (
      left.lastUsedAt - right.lastUsedAt ||
      left.accountId.localeCompare(right.accountId)
    ))) {
      if (candidate.weight <= 0) continue
      total += candidate.weight
      const current = (state.get(candidate.accountId) || 0) + candidate.weight
      state.set(candidate.accountId, current)
      if (!selected || current > selectedCurrent) {
        selected = candidate
        selectedCurrent = current
      }
    }
    if (!selected) {
      return [...candidates].sort((left, right) => left.accountId.localeCompare(right.accountId))[0]
    }
    state.set(selected.accountId, (state.get(selected.accountId) || 0) - total)
    return selected
  }

  reserve(candidate) {
    const current = this.inflight.get(candidate.accountId) || 0
    if (current >= candidate.maxConcurrency) return null
    this.inflight.set(candidate.accountId, current + 1)
    this.accountQuota?.acquire?.(candidate.accountId)
    let released = false
    return {
      reserved: true,
      release: () => {
        if (released) return
        released = true
        const next = Math.max(0, (this.inflight.get(candidate.accountId) || 1) - 1)
        if (next === 0) this.inflight.delete(candidate.accountId)
        else this.inflight.set(candidate.accountId, next)
        this.accountQuota?.release?.(candidate.accountId)
        this.notifyCapacity()
      },
    }
  }

  markSuccess(candidate, { workerStatus = null } = {}) {
    const now = Date.now()
    this.lastUsed.set(candidate.accountId, now)
    this.runtimeRepo?.upsert?.({
      account_id: candidate.accountId,
      vm_id: candidate.vmId,
      status: 'ready',
      priority: candidate.priority,
      weight: candidate.weight,
      cooldown_until: null,
      cooldown_reason: null,
      last_used_at: now,
      worker_heartbeat_at: workerStatus ? now : candidate.state?.worker_heartbeat_at,
      worker_status: workerStatus || candidate.state?.worker_status || null,
    })
  }

  markCooldown(candidate, {
    until,
    reason,
    model = null,
    status = 'cooldown',
  } = {}) {
    this.runtimeRepo?.markCooldown?.(candidate.accountId, {
      vmId: candidate.vmId,
      until,
      reason,
      model: model ? normalizeModel(model) : null,
      status,
    })
    this.healthCache.delete(candidate.vmId)
  }

  waitForCapacity({ signal, deadline, stickyKey }) {
    const maxWaiters = Math.max(1, Number(this.config.max_waiters_per_account) || 32)
    if (this.waiters.size >= maxWaiters) {
      throw Object.assign(new Error('Account pool wait queue is full'), { code: 'pool_wait_queue_full' })
    }
    const id = Symbol('pool-waiter')
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, deadline - Date.now())
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, remaining)
      timer.unref?.()
      const onAbort = () => {
        cleanup()
        reject(makeAbortError())
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        this.waiters.delete(id)
      }
      this.waiters.set(id, () => {
        cleanup()
        const jitter = stickyKey ? Math.floor(Math.random() * 20) : 0
        if (jitter) setTimeout(resolve, jitter)
        else resolve()
      })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  notifyCapacity() {
    const callbacks = [...this.waiters.values()]
    this.waiters.clear()
    for (const callback of callbacks) {
      try { callback() } catch {}
    }
  }

  snapshot() {
    return {
      strategy: this.config.strategy,
      inflight: Object.fromEntries(this.inflight),
      waiters: this.waiters.size,
      health_cache: Object.fromEntries([...this.healthCache].map(([id, entry]) => [id, entry.value])),
    }
  }
}
