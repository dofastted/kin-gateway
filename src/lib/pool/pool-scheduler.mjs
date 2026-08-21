import { getVm, listVms, setVmSchedulable } from '../vm/vm-registry.mjs'
import { vmCliHomePath, vmJsonPath } from '../vm/execution-context.mjs'
import { mirrorWorkerCredentialsToVm } from '../oauth/oauth-credentials.mjs'
import { FABLE_FAMILY_KEY, isFableModel, modelCooldownKeys } from './upstream-error-policy.mjs'
import {
  evaluateCredentialEligibility,
  evaluateSlotGate,
  isCredentialRuntimeBlocked,
} from './schedule-eligibility.mjs'
import { splitBlocksModel } from './weekly-split.mjs'

const DEFAULT_CONFIG = {
  strategy: 'weighted-round-robin',
  max_waiters_per_account: 32,
  fallback_wait_timeout_ms: 120000,
  sticky_wait_timeout_ms: 120000,
  worker_health_ttl_ms: 5000,
  heartbeat_stale_ms: 15000,
  fable_max_per_account: 4,
  default_max_per_account: 20,
}

function accountIdOf(vm) {
  return vm?.claude?.account_uuid || vm?.id || null
}

function parseConcurrency(value, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, n)
}

function maxConcurrencyOf(vm, fallback = 20) {
  return parseConcurrency(vm?.policy?.maxConcurrency, fallback)
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
    this.inflightFamily = new Map()
    this.waiters = new Map()
    this.healthCache = new Map()
    this.smooth = new Map()
    this.lastUsed = new Map()
    this.cooldownTimers = new Map()
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
      const selected = this.pick(available, { model, stickyKey, eligible: candidates })
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
          reason: 'all_accounts_busy',
          waitMs: Date.now() - startedAt,
        }
      }
      const wakeAts = candidates
        .map((candidate) => Number(candidate.availableAt) || 0)
        .filter((value) => value > Date.now())
      const wakeAt = wakeAts.length ? Math.min(finalDeadline, ...wakeAts) : finalDeadline
      await this.waitForCapacity({
        signal,
        deadline: wakeAt,
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
      const maxConcurrency = maxConcurrencyOf(vm, parseConcurrency(this.config.default_max_per_account, 20))
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
        availableAt: eligibility.availableAt || null,
        waitReason: eligibility.waitReason || null,
        exec: this.executionContext(vm, accountId),
      })
    }
    return candidates
  }

  async checkEligibility({ vm, accountId, state, model, now, signal }) {
    const gate = evaluateSlotGate(vm)
    if (!gate.ok) return gate
    const expired = evaluateCredentialEligibility({ vm, now })
    if (!expired.ok && expired.reason === 'oauth_expired') return expired
    if (!expired.ok && expired.reason === 'no_credential') return expired
    if (isCredentialRuntimeBlocked(state, now)) return { ok: false, reason: 'credential_blocked' }
    const fallbackCap = parseConcurrency(this.config.default_max_per_account, 20)
    const maxConcurrency = maxConcurrencyOf(vm, fallbackCap)
    if (maxConcurrency <= 0) return { ok: false, reason: 'concurrency_disabled' }
    let busy = false
    let availableAt = null
    let waitReason = null
    const markWait = (reason, until = null) => {
      busy = true
      waitReason = waitReason || reason
      const next = Number(until) || 0
      if (next > now) availableAt = availableAt ? Math.min(availableAt, next) : next
    }
    if (state && cooldownActive(state.cooldown_until, now)) {
      markWait('account_cooldown', state.cooldown_until)
    }
    const modelKey = normalizeModel(model)
    for (const key of modelCooldownKeys(modelKey)) {
      const modelState = state?.model_states?.[key]
      if (modelState && cooldownActive(modelState.cooldown_until, now)) {
        markWait(key === FABLE_FAMILY_KEY ? 'fable_cooldown' : 'model_cooldown', modelState.cooldown_until)
      }
    }
    if (isFableModel(modelKey) && this.accountQuota?.fableWindowLimited?.(accountId)) {
      const until = this.accountQuota.fableWindowResetAt?.(accountId)
      markWait('fable_quota', until)
    }
    if (this.accountQuota?.weeklySplitOf) {
      const split = this.accountQuota.weeklySplitOf(accountId)
      const reason = splitBlocksModel(split, modelKey)
      if (reason) {
        const until = this.accountQuota.weeklySplitResetAt?.(
          accountId,
          reason === 'fable_split' ? 'fable' : 'regular',
        )
        markWait(reason, until)
      }
    }
    const inflight = this.inflight.get(accountId) || 0
    if (inflight >= maxConcurrency) markWait('concurrency_limit')
    const fableCap = Number(this.config.fable_max_per_account)
    if (isFableModel(modelKey) && Number.isFinite(fableCap) && fableCap > 0) {
      const familyInflight = this.familyInflight(accountId, FABLE_FAMILY_KEY)
      if (familyInflight >= fableCap) markWait('fable_concurrency')
    }
    if (this.accountQuota) {
      const quotaGate = this.accountQuota.canAccept(accountId)
      if (!quotaGate.ok) {
        if (quotaGate.reason === 'concurrency_limit') markWait('concurrency_limit')
        else return { ok: false, reason: quotaGate.reason || 'quota_gate' }
      }
    }
    const workerStatus = await this.getWorkerHealth(this.executionContext(vm, accountId), { signal })
    const cred = evaluateCredentialEligibility({ vm, workerStatus, now })
    if (!cred.ok) return cred
    return { ok: true, workerStatus, busy, availableAt, waitReason }
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
      const prev = this.runtimeRepo.get?.(exec.accountId)
      const prevGen = Number(prev?.credential_generation) || 0
      const nextGen = Number(value?.credential?.generation) || 0
      this.runtimeRepo.upsert({
        account_id: exec.accountId,
        vm_id: exec.vmId,
        status: value?.ok ? 'ready' : 'worker_unhealthy',
        worker_heartbeat_at: now,
        worker_status: value,
        credential_generation: nextGen,
        refresh_status: value?.credential?.needs_refresh ? 'needed' : 'fresh',
      })
      if (
        value?.ok &&
        value?.credential?.has_access &&
        nextGen > prevGen &&
        exec.homeDir &&
        exec.vmId
      ) {
        try {
          const vmPath = String(exec.homeDir).replace(/\/cli-home\/?$/, '.json')
          const mirrored = mirrorWorkerCredentialsToVm(vmPath, exec.homeDir)
          const uuid = mirrored?.claude?.account_uuid || exec.accountId
          if (uuid && uuid !== exec.vmId) {
            this.accountQuota?.rebindToVm?.(uuid, exec.vmId, { email: mirrored?.claude?.email })
          }
        } catch {}
      }
      if (
        value?.ok &&
        value?.credential?.has_access &&
        !value?.credential?.needs_refresh &&
        exec.vmId
      ) {
        try {
          const live = getVm(this.projectRoot, exec.vmId)
          if (/^oauth_/.test(String(live?.schedule_disabled_reason || ''))) {
            setVmSchedulable(this.projectRoot, exec.vmId, true)
          }
        } catch {}
      }
    }
    return value
  }

  pick(candidates, { model, stickyKey, eligible = candidates } = {}) {
    if (!candidates.length && !eligible?.length) return null
    const bound = stickyKey ? this.stickyRouter?.resolve?.(stickyKey) : null
    if (bound) {
      const match = (candidate) => (
        candidate.vmId === bound.vmId &&
        candidate.accountId === bound.accountId
      )
      const amongEligible = (eligible || candidates).find(match)
      if (!amongEligible) {
        this.stickyRouter?.unbind?.(stickyKey)
      } else if (amongEligible.busy) {
        return null
      } else {
        return { ...amongEligible, selectionReason: 'sticky' }
      }
    }
    if (!candidates.length) return null
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

  familyInflight(accountId, family) {
    return this.inflightFamily.get(accountId)?.get(family) || 0
  }

  bumpFamily(accountId, family, delta) {
    if (!family) return
    let byFamily = this.inflightFamily.get(accountId)
    if (!byFamily) {
      byFamily = new Map()
      this.inflightFamily.set(accountId, byFamily)
    }
    const next = Math.max(0, (byFamily.get(family) || 0) + delta)
    if (next === 0) byFamily.delete(family)
    else byFamily.set(family, next)
    if (byFamily.size === 0) this.inflightFamily.delete(accountId)
  }

  reloadConfig(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) }
  }

  reserve(candidate) {
    const current = this.inflight.get(candidate.accountId) || 0
    if (!candidate.maxConcurrency || current >= candidate.maxConcurrency) return null
    const family = isFableModel(candidate.model) ? FABLE_FAMILY_KEY : null
    const fableCap = Number(this.config.fable_max_per_account)
    if (family && Number.isFinite(fableCap) && fableCap > 0 && this.familyInflight(candidate.accountId, family) >= fableCap) {
      return null
    }
    this.inflight.set(candidate.accountId, current + 1)
    this.bumpFamily(candidate.accountId, family, 1)
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
        this.bumpFamily(candidate.accountId, family, -1)
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
    this.scheduleCooldownWake(candidate.accountId, until)
  }

  scheduleCooldownWake(accountId, until) {
    const prev = this.cooldownTimers.get(accountId)
    if (prev) clearTimeout(prev)
    const delay = Math.max(1, Number(until) - Date.now())
    if (!Number.isFinite(delay) || delay > 24 * 60 * 60 * 1000) return
    const timer = setTimeout(() => {
      this.cooldownTimers.delete(accountId)
      this.notifyCapacity()
    }, delay)
    timer.unref?.()
    this.cooldownTimers.set(accountId, timer)
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
    const family = {}
    for (const [accountId, byFamily] of this.inflightFamily) {
      family[accountId] = Object.fromEntries(byFamily)
    }
    return {
      strategy: this.config.strategy,
      fable_max_per_account: this.config.fable_max_per_account,
      inflight: Object.fromEntries(this.inflight),
      inflight_family: family,
      waiters: this.waiters.size,
      health_cache: Object.fromEntries([...this.healthCache].map(([id, entry]) => [id, entry.value])),
    }
  }
}
