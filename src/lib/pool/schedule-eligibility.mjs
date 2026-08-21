/**
 * Single schedulability gate shared by the pool picker and the panel.
 * Green on the console must mean the scheduler will actually select the slot.
 */
import { isVmScheduleReady, vmHasClaudeCredential } from '../vm/vm-registry.mjs'
import { expiresAtToMs, isFullyExpired } from '../oauth/oauth-credentials.mjs'

const CREDENTIAL_COOLDOWN = /oauth_|authentication_failed|permission_denied|credential/i
const REFRESH_FAILURE = /credential_refresh_failed|oauth_refresh|refresh_token|invalid_grant/i

export function isRefreshFailure(workerStatus) {
  const err = String(workerStatus?.last_error || workerStatus?.error || workerStatus?.code || '')
  return REFRESH_FAILURE.test(err)
}

export function isCredentialRuntimeBlocked(state, now = Date.now()) {
  if (!state) return false
  if (String(state.status || '') === 'disabled') return true
  const until = Number(state.cooldown_until) || 0
  if (until > now && CREDENTIAL_COOLDOWN.test(String(state.cooldown_reason || ''))) return true
  return false
}

export function evaluateSlotGate(vm) {
  if (!isVmScheduleReady(vm)) return { ok: false, reason: 'vm_unschedulable' }
  if (!vmHasClaudeCredential(vm)) return { ok: false, reason: 'no_credential' }
  if (!vm.proxy_cli_enabled || !vm.proxy?.url) return { ok: false, reason: 'proxy_required' }
  return { ok: true }
}

export function evaluateCredentialEligibility({ vm, workerStatus = null, now = Date.now() } = {}) {
  if (!vmHasClaudeCredential(vm)) return { ok: false, reason: 'no_credential' }
  if (isFullyExpired(vm?.claude?.expires_at, now)) return { ok: false, reason: 'oauth_expired' }
  const expMs = expiresAtToMs(vm?.claude?.expires_at)
  if (!expMs && workerStatus && !workerStatus?.credential?.has_access) {
    return { ok: false, reason: 'oauth_unconfirmed' }
  }
  if (workerStatus) {
    if (workerStatus.ok !== true || isRefreshFailure(workerStatus)) {
      return { ok: false, reason: 'worker_unhealthy' }
    }
  }
  return { ok: true }
}

export function credPanelUnavailable(extras = {}, expiresAt = null, now = Date.now()) {
  if (extras.schedulable === false) return true
  if (/^oauth_/.test(String(extras.schedule_disabled_reason || ''))) return true
  if (isCredentialRuntimeBlocked(extras.runtime || extras.state, now)) return true
  const expMs = expiresAtToMs(expiresAt)
  if (expMs && expMs <= now) return true
  return false
}
