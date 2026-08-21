/**
 * Multi-VM registry — load all vms/*.json (except active.json)
 * Writes go through atomicWriteJson so the DB credential mirror
 * (lib/vm-db-sync.mjs) sees every change.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './vm-file.mjs'
import { hasAccessPresence, hasCredentialPresence, hasRefreshPresence } from '../oauth/oauth-credentials.mjs'

export function listVms(projectRoot) {
  const dir = path.join(projectRoot, 'vms')
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('vm-') && f.endsWith('.json'))
  return files.map((f) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!raw?.id) return null
      return summarizeVm(raw)
    } catch {
      return null
    }
  }).filter(Boolean)
}

export function getVm(projectRoot, id) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function summarizeVm(vm) {
  return {
    id: vm.id,
    name: vm.name,
    status: vm.status || 'unknown',
    kernel: vm.kernel || null,
    seed_policy: vm.seed_policy || null,
    region: vm.region || vm.zone || null,
    note: vm.note || null,
    email: vm.claude?.email || null,
    account_uuid: vm.claude?.account_uuid || null,
    org_uuid: vm.claude?.org_uuid || null,
    has_token: hasAccessPresence(vm.claude),
    expires_at: vm.claude?.expires_at || null,
    refreshed_at: vm.claude?.refreshed_at || null,
    oauth_source: vm.claude?.source || null,
    has_refresh: hasRefreshPresence(vm.claude),
    has_session_key: false,
    max_concurrency: vm.policy?.maxConcurrency ?? 20,
    weight: vm.policy?.weight ?? 1,
    timezone: vm.timezone || null,
    locale: vm.locale || null,
    proxy: vm.proxy || null,
    claude_code_version: vm.claude_code_version || null,
    stats: vm.stats || {},
    fingerprint: vm.fingerprint || null,
    schedulable: vm.schedulable !== false,
    schedule_disabled_reason: vm.schedule_disabled_reason || null,
    proxy_id: vm.proxy?.id || null,
    proxy_cli_enabled: !!vm.proxy_cli_enabled,
    created_at: vm.created_at || null,
    runtime: vm.runtime || null,
    ip: vm.runtime?.ip || null,
    pid: vm.runtime?.pid || null,
    container: vm.runtime?.container || null,
  }
}

export function getActiveVmId(projectRoot) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', 'active.json'), 'utf8'))
    return a.active_vm
  } catch {
    return null
  }
}

export function setActiveVm(projectRoot, id) {
  const file = path.join(projectRoot, 'vms', 'active.json')
  atomicWriteJson(file, { active_vm: id, updated_at: new Date().toISOString() })
}


/** Statuses that mean the slot is actually down — not a soft UI pause. */
const HARD_UNAVAILABLE = new Set(['stopped', 'dead', 'error', 'disabled'])

export function vmHasClaudeCredential(vm) {
  return hasCredentialPresence(vm?.claude)
}

/**
 * Soft `paused` is only a UI mark written by setVmSchedulable(false).
 * If schedulable is back on, the account must remain selectable.
 * Empty inventory slots (no Claude token) stay out of the pool.
 */
export function isVmScheduleReady(vm) {
  if (!vm) return false
  if (vm.schedulable === false) return false
  if (!vmHasClaudeCredential(vm)) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_UNAVAILABLE.has(status)) return false
  return true
}

export function setVmSchedulable(projectRoot, id, schedulable, reason = null, { preserveStatus = false } = {}) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.schedulable = !!schedulable
  vm.schedule_updated_at = new Date().toISOString()
  vm.updated_at = vm.schedule_updated_at
  if (schedulable) {
    vm.schedule_disabled_reason = null
    if (!preserveStatus && String(vm.status || '').toLowerCase() === 'paused') vm.status = 'running'
  } else {
    vm.schedule_disabled_reason = reason || 'disabled'
    if (!preserveStatus && String(vm.status || '').toLowerCase() === 'running') vm.status = 'paused'
  }
  atomicWriteJson(file, vm)
  return summarizeVm(vm)
}

export function bindVmProxy(projectRoot, id, proxyInfo) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.proxy = proxyInfo
    ? {
        id: proxyInfo.id,
        host: proxyInfo.host,
        port: proxyInfo.port,
        scheme: 'socks5',
        url: proxyInfo.url || null,
      }
    : null
  if (proxyInfo) vm.proxy_cli_enabled = true
  atomicWriteJson(file, vm)
  return summarizeVm(vm)
}
