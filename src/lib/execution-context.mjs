/**
 * Per-request execution context.
 * Inference must NEVER use process-global cfg.vm. Every hop reads the
 * scheduled VM record: home, OAuth, seed, proxy, quota account, kernel metadata.
 *
 * Runtime is a Docker container per VM (isolated PID/net/fs). Host has no nested KVM.
 */
import path from 'node:path'
import { getVm, listVms, getActiveVmId } from './vm-registry.mjs'
import { defaultSeedPolicy } from './cli-runner.mjs'
import { harvestHomeToVm, readCliOauth } from './oauth-refresh.mjs'

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

export function buildExecutionContext({
  cfg,
  inbound = {},
  req = {},
  protocol = null,
  pathName = null,
  stickyRouter = null,
  preferredVmId = null,
}) {
  const project = cfg.paths.project
  const stickyKey = stickyRouter ? stickyRouter.extractKey(req, inbound) : null
  const bound = stickyKey && stickyRouter ? stickyRouter.resolve(stickyKey) : null
  let vmId = null
  if (preferredVmId && getVm(project, preferredVmId)) {
    vmId = preferredVmId
  } else {
    vmId = pickSchedulableVmId(project, bound?.vmId || null)
  }
  if (!vmId) {
    return { ok: false, error: 'no_schedulable_vm', message: 'No schedulable VM with credentials' }
  }
  const vm = getVm(project, vmId)
  if (!vm) {
    return { ok: false, error: 'vm_not_found', message: `VM '${vmId}' not found` }
  }
  const oauth = snapshotOauth(vm)
  const accountId = bound?.vmId === vmId
    ? (bound?.accountId || oauth.account_uuid || vmId)
    : (oauth.account_uuid || vmId)
  const seedPolicy = defaultSeedPolicy(vm.seed_policy || {})
  return {
    ok: true,
    exec: {
      protocol,
      path: pathName,
      vmId,
      vm,
      vmPath: vmJsonPath(project, vmId),
      homeDir: vmCliHomePath(project, vmId),
      accountId,
      oauth,
      seedPolicy,
      proxyUrl: resolveVmProxyUrl(vm),
      timezone: vm.timezone || 'UTC',
      locale: vm.locale || 'en_US.UTF-8',
      kernel: vm.kernel || null,
      stickyKey,
      stickyBound: bound,
      capabilities: GATEWAY_CAPABILITIES,
    },
  }
}

export function refreshExecOauth(exec) {
  if (!exec?.vmPath || !exec?.vmId) return exec
  const project = path.dirname(path.dirname(exec.vmPath))
  const fresh = getVm(project, exec.vmId)
  if (fresh) {
    exec.vm = fresh
    exec.oauth = snapshotOauth(fresh)
  }
  return exec
}

export function harvestExecHome(exec) {
  if (!exec?.homeDir || !exec?.vmPath) return { harvested: false }
  const r = harvestHomeToVm(exec.homeDir, exec.vmPath)
  if (r.harvested) {
    const disk = readCliOauth(exec.homeDir)
    if (disk) exec.oauth = { ...exec.oauth, ...disk }
  }
  return r
}

export function buildCliOptsFromExec(exec, body, extra = {}) {
  return {
    model: body?.model,
    body,
    accessToken: exec.oauth?.access_token,
    refreshToken: exec.oauth?.refresh_token || null,
    expiresAt: exec.oauth?.expires_at || null,
    proxyUrl: exec.proxyUrl,
    homeDir: exec.homeDir,
    timezone: exec.timezone,
    locale: exec.locale,
    kernel: exec.kernel,
    seedPolicy: exec.seedPolicy,
    timeoutMs: extra.timeoutMs || 180000,
  }
}
