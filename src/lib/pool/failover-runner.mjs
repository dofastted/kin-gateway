import {
  classifyUpstreamResult,
  repairAnthropicRequest,
  shouldContinue,
} from './upstream-error-policy.mjs'

const DEFAULTS = {
  max_account_switches: 10,
  max_total_attempts: 12,
  total_retry_deadline_ms: 120000,
  delivery_mode: 'realtime',
}

export const SERVER_OVERLOAD_MESSAGE = '服务器负载过高稍后重试'

function isTransientPoolScope(scope) {
  return scope === 'provider' || scope === 'worker' || scope === 'proxy' || scope === 'model'
}

function clone(value) {
  return structuredClone(value)
}

function usageOf(result) {
  return result?.usage || result?.body?.usage || null
}

function verifiedSuccess(result) {
  return !!result?.ok && result?.terminalState === 'verified'
}

function poolError(code, message, details = {}) {
  return {
    ok: false,
    status: 503,
    via: 'pool-failover',
    terminalState: 'exhausted',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code,
        message,
        details,
      },
    },
  }
}

function poolOverloadError(details = {}) {
  return poolError('server_overloaded', SERVER_OVERLOAD_MESSAGE, details)
}

function notifyProxyFailure(onProxyFailure, selected, policy) {
  if (policy?.reason !== 'proxy_transport_failure') return
  if (typeof onProxyFailure !== 'function') return
  try {
    onProxyFailure(selected?.vmId, policy.reason)
  } catch {
    /* control-plane disconnect is best-effort */
  }
}

export class FailoverRunner {
  constructor({
    scheduler,
    stickyRouter = null,
    attemptsRepo = null,
    config = {},
    onProxyFailure = null,
  } = {}) {
    this.scheduler = scheduler
    this.stickyRouter = stickyRouter
    this.attemptsRepo = attemptsRepo
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.onProxyFailure = onProxyFailure
  }

  async run({
    requestId,
    canonicalBody,
    model,
    stickyKey = null,
    stream = false,
    deliveryMode = null,
    signal,
    applyAttempt,
    callAttempt,
    onAttempt = null,
  } = {}) {
    if (!this.scheduler) throw new Error('FailoverRunner requires a scheduler')
    if (typeof callAttempt !== 'function') throw new Error('FailoverRunner requires callAttempt')
    const startedAt = Date.now()
    const deadline = startedAt + Number(this.config.total_retry_deadline_ms || 120000)
    const excluded = new Set()
    let lastResult = null
    let lastPolicy = null
    let accountSwitches = 0
    let repaired = false
    let requestBody = clone(canonicalBody)

    for (let attemptNo = 1; attemptNo <= this.config.max_total_attempts; attemptNo++) {
      if (signal?.aborted) {
        return poolError('request_cancelled', 'Request was cancelled', { attempt_count: attemptNo - 1 })
      }
      if (Date.now() >= deadline) {
        return poolOverloadError({
          reason: 'pool_deadline_exceeded',
          attempt_count: attemptNo - 1,
          last_scope: lastPolicy?.scope || null,
        })
      }
      let selected
      try {
        selected = await this.scheduler.selectAndReserve({
          model,
          stickyKey,
          excluded,
          signal,
          deadline,
          allowWait: true,
        })
      } catch (error) {
        if (error?.code === 'selection_cancelled') {
          return poolError('request_cancelled', 'Request was cancelled', { attempt_count: attemptNo - 1 })
        }
        if (error?.code === 'pool_wait_queue_full') {
          return poolOverloadError({
            reason: 'pool_wait_queue_full',
            attempt_count: attemptNo - 1,
          })
        }
        throw error
      }
      if (!selected?.ok) {
        return poolOverloadError({
          excluded_accounts: [...excluded],
          reason: selected?.reason || 'no_eligible_accounts',
          wait_ms: selected?.waitMs || 0,
          attempt_count: attemptNo - 1,
          last_scope: lastPolicy?.scope || null,
        })
      }
      const attemptStarted = Date.now()
      const prepared = typeof applyAttempt === 'function'
        ? await applyAttempt(clone(requestBody), selected, { attemptNo, repaired })
        : clone(requestBody)
      const wrappedAttempt = prepared && typeof prepared === 'object' &&
        Object.prototype.hasOwnProperty.call(prepared, 'body') &&
        Object.prototype.hasOwnProperty.call(prepared, 'meta')
      const body = wrappedAttempt ? prepared.body : prepared
      const attemptMeta = wrappedAttempt ? prepared.meta : null
      this.attemptsRepo?.begin?.({
        requestId,
        attemptNo,
        vmId: selected.vmId,
        accountId: selected.accountId,
        model,
        selectionReason: selected.selectionReason,
        waitMs: selected.waitMs,
      })
      let result
      let policy
      let committed = false
      try {
        result = await callAttempt({
          candidate: selected,
          body,
          attemptMeta,
          attemptNo,
          stream,
          deliveryMode: deliveryMode || this.config.delivery_mode,
          signal,
          onCommit: () => { committed = true },
        })
        if (result) result.committed = result.committed || committed
        policy = classifyUpstreamResult(result, { model, repaired })
        lastResult = result
        lastPolicy = policy
        notifyProxyFailure(this.onProxyFailure, selected, policy)
        const terminalState = result?.terminalState || (result?.ok ? 'unknown' : 'error')
        this.attemptsRepo?.complete?.(requestId, attemptNo, {
          upstreamStatus: result?.status ?? null,
          errorScope: policy.scope,
          action: policy.action,
          cooldownUntil: policy.cooldownUntil,
          downstreamCommitted: result?.committed || committed,
          terminalState,
          usage: usageOf(result),
          ttftMs: result?.ttftMs ?? null,
          latencyMs: Date.now() - attemptStarted,
        })
        if (typeof onAttempt === 'function') {
          await onAttempt({ attemptNo, selected, result, policy })
        }
        if (verifiedSuccess(result)) {
          this.scheduler.markSuccess(selected, { workerStatus: result.workerStatus || null })
          if (stickyKey) {
            this.stickyRouter?.bind?.(stickyKey, {
              accountId: selected.accountId,
              vmId: selected.vmId,
            })
          }
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: 'verified',
          }
        }
        if (policy.action === 'repair-and-retry' && !repaired && !result?.committed) {
          repaired = true
          requestBody = repairAnthropicRequest(requestBody, policy)
          continue
        }
        if (policy.action === 'continue-and-cooldown' || policy.action === 'disable') {
          this.scheduler.markCooldown(selected, {
            until: policy.action === 'disable'
              ? Number.MAX_SAFE_INTEGER
              : policy.cooldownUntil,
            reason: policy.reason,
            model: policy.scope === 'model' ? (policy.model || model) : null,
            status: policy.action === 'disable' ? 'disabled' : 'cooldown',
          })
        }
        if (!shouldContinue(policy)) {
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: result?.terminalState || 'rejected',
            policy,
          }
        }
        if (!isTransientPoolScope(policy.scope)) {
          excluded.add(selected.accountId)
          excluded.add(selected.vmId)
          accountSwitches++
          if (accountSwitches > this.config.max_account_switches) {
            return poolOverloadError({
              reason: 'max_account_switches_exceeded',
              attempt_count: attemptNo,
              last_scope: policy.scope,
            })
          }
        }
      } catch (error) {
        result = {
          ok: false,
          status: 0,
          transportError: true,
          committed,
          terminalState: committed ? 'incomplete' : 'transport_error',
          body: {
            type: 'error',
            error: {
              type: 'worker_error',
              code: error.code || 'attempt_failed',
              message: String(error.message || error).slice(0, 300),
            },
          },
        }
        policy = classifyUpstreamResult(result, { model, repaired })
        lastResult = result
        lastPolicy = policy
        notifyProxyFailure(this.onProxyFailure, selected, policy)
        this.attemptsRepo?.complete?.(requestId, attemptNo, {
          upstreamStatus: 0,
          errorScope: policy.scope,
          action: policy.action,
          cooldownUntil: policy.cooldownUntil,
          downstreamCommitted: committed,
          terminalState: result.terminalState,
          latencyMs: Date.now() - attemptStarted,
        })
        if (committed || !shouldContinue(policy)) {
          return {
            ...result,
            accountId: selected.accountId,
            vmId: selected.vmId,
            attemptCount: attemptNo,
            finalState: result.terminalState,
            policy,
          }
        }
        this.scheduler.markCooldown(selected, {
          until: policy.cooldownUntil,
          reason: policy.reason,
        })
        if (!isTransientPoolScope(policy.scope)) {
          excluded.add(selected.accountId)
          excluded.add(selected.vmId)
          accountSwitches++
        }
      } finally {
        selected.release?.()
      }
    }
    return poolOverloadError({
      reason: 'attempts_exhausted',
      max_attempts: this.config.max_total_attempts,
      last_scope: lastPolicy?.scope || null,
    })
  }
}
