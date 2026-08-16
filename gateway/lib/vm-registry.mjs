/**
 * Multi-VM registry — load all vms/*.json (except active.json)
 */
import fs from 'node:fs'
import path from 'node:path'

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
    has_token: !!vm.claude?.access_token,
    expires_at: vm.claude?.expires_at || null,
    max_concurrency: vm.policy?.maxConcurrency ?? 2,
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
    created_at: vm.created_at || null,
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
  fs.writeFileSync(file, JSON.stringify({ active_vm: id, updated_at: new Date().toISOString() }, null, 2))
}


export function setVmSchedulable(projectRoot, id, schedulable, reason = null) {
  const file = path.join(projectRoot, 'vms', `${id}.json`)
  if (!fs.existsSync(file)) return null
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  vm.schedulable = !!schedulable
  vm.schedule_disabled_reason = schedulable ? null : (reason || 'disabled')
  vm.schedule_updated_at = new Date().toISOString()
  if (!schedulable) {
    // mark soft status for UI
    vm.status = vm.status === 'running' ? 'paused' : vm.status
  }
  fs.writeFileSync(file, JSON.stringify(vm, null, 2))
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
  fs.writeFileSync(file, JSON.stringify(vm, null, 2))
  return summarizeVm(vm)
}
