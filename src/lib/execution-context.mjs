/**
 * Slot execution metadata.
 * Inference never uses process-global cfg.vm. The pool scheduler builds a
 * per-attempt candidate from the scheduled VM record: paths, OAuth snapshot,
 * proxy, quota account.
 *
 * Runtime: one Docker container + one long-lived Go slot worker per VM.
 */
import path from 'node:path'
import { getVm, listVms, getActiveVmId } from './vm-registry.mjs'

export const GATEWAY_CAPABILITIES = {
  runtime: 'docker-container',
  kernel: 'mixed-os-docker',
  worker: 'go-slot-worker',
  client_tools: true,
  images: true,
  multi_turn_native: true,
  sticky: 'vm-account',
  claude_session: false,
  workspace_default: 'client',
  tool_execution: 'client',
  forward_default: 'relay',
  stream_delivery_default: 'realtime',
  stream_delivery_optional: 'verified',
}

export function vmJsonPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', `${vmId}.json`)
}

export function vmCliHomePath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId || 'default', 'cli-home')
}

export function resolveVmProxyUrl(vm) {
  if (!vm?.proxy_cli_enabled) return null
  const p = vm.proxy
  if (!p) return null
  if (p.url) return String(p.url)
  if (p.host && p.port) {
    const auth = p.username
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@`
      : ''
    return `socks5h://${auth}${p.host}:${p.port}`
  }
  return null
}

export function pickSchedulableVmId(projectRoot, preferredId = null) {
  const seen = new Set()
  const order = []
  const push = (id) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    order.push(id)
  }
  push(preferredId)
  push(getActiveVmId(projectRoot))
  for (const s of listVms(projectRoot)) push(s.id)
  for (const id of order) {
    const vm = getVm(projectRoot, id)
    if (!vm) continue
    if (vm.status !== 'running') continue
    if (vm.schedulable === false) continue
    if (!vm.proxy_cli_enabled || !vm.proxy?.url) continue
    const tok = vm.claude?.access_token || vm.claude?.refresh_token || vm.claude?.session_key
    if (!tok) continue
    return id
  }
  return null
}

export function snapshotOauth(vm) {
  const c = vm?.claude || {}
  return {
    access_token: c.access_token || null,
    refresh_token: c.refresh_token || null,
    expires_at: c.expires_at || null,
    session_key: c.session_key || null,
    email: c.email || null,
    account_uuid: c.account_uuid || null,
    org_uuid: c.org_uuid || null,
    refresh_error: c.refresh_error || null,
  }
}
