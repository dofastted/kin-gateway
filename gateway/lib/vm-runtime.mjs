/**
 * Real VM runtime: one Docker container per kin VM.
 * Mixed guest OS: Ubuntu 24.04 / Debian 12 / Arch / Fedora 41.
 * Default network is host-mode.
 * SOCKS-bound VMs use a dedicated netns: transparent TCP redirect → SOCKS5.
 * Guest has no HTTP_PROXY/ALL_PROXY — egress is wrapped outside the VM.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const RUNTIME = 'docker'
const NODE_ROOT = process.env.KIN_NODE_ROOT || '/usr/local/lib/nodejs'
const LIB_ROOT = process.env.KIN_LIB_ROOT || '/opt/kin-gateway/gateway/lib'
const UID = String(process.env.KIN_VM_UID || 999)
const GID = String(process.env.KIN_VM_GID || 987)
const MEM = process.env.KIN_VM_MEMORY || '768m'
const NET = process.env.KIN_VM_NETWORK || 'host'
const PUBLIC_IP = process.env.PUBLIC_HOST || '166.88.96.199'

export const OS_CATALOG = {
  'ubuntu-24.04': { image: 'kin-os/ubuntu:24.04', family: 'ubuntu', pretty: 'Ubuntu 24.04' },
  'debian-12': { image: 'kin-os/debian:12', family: 'debian', pretty: 'Debian 12' },
  'archlinux': { image: 'kin-os/arch:latest', family: 'arch', pretty: 'Arch Linux' },
  'fedora-41': { image: 'kin-os/fedora:41', family: 'fedora', pretty: 'Fedora 41' },
}

export const OS_ORDER = ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41']
export const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
]
export const STANDARD_LOCALE = 'en_US.UTF-8'
export const CLAUDE_VER = '2.1.234'

export function kernelForIndex(i) {
  return OS_ORDER[(Number(i) - 1) % OS_ORDER.length]
}

export function timezoneForIndex(i) {
  return US_TIMEZONES[(Number(i) - 1) % US_TIMEZONES.length]
}

export function normalizeUsTimezone(tz) {
  const s = String(tz || '').trim()
  if (s.startsWith('America/')) return s
  return 'America/Los_Angeles'
}

export function imageForKernel(kernel) {
  return (OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']).image
}

export function parseVmIndex(value) {
  const s = String(value || '')
  const m = s.match(/^vm-(\d+)$/i) || s.match(/^0*(\d+)$/)
  return m ? Number(m[1]) : null
}

export function padVm(n) {
  return String(n).padStart(2, '0')
}

export function nextNumericIndex(vms) {
  const used = new Set()
  for (const v of vms || []) {
    const n = parseVmIndex(v?.name) ?? parseVmIndex(v?.id)
    if (n) used.add(n)
  }
  let n = 1
  while (used.has(n)) n++
  return n
}

function sh(argv, opts = {}) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: opts.timeout ?? 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: out.trim(), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || '').trim(),
      stderr: String(e.stderr || e.message || '').trim(),
      code: e.status,
    }
  }
}

export function containerName(vmId) {
  return `kin-${String(vmId || '').replace(/^vm-/, '')}`
}

export function displayName(vmId) {
  return String(vmId || '').replace(/^vm-/, '')
}

export function inspectContainer(name) {
  const r = sh([
    'docker', 'inspect',
    '--format',
    '{{.State.Running}}|{{.State.Pid}}|{{.HostConfig.NetworkMode}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.Config.Hostname}}',
    name,
  ])
  if (!r.ok) return null
  const [running, pid, networkMode, startedAt, image, hostname] = r.stdout.split('|')
  return {
    name,
    running: running === 'true',
    pid: Number(pid) || 0,
    ip: networkMode === 'host' ? PUBLIC_IP : null,
    networkMode: networkMode || null,
    startedAt: startedAt || null,
    image: image || null,
    hostname: hostname || null,
  }
}


function vmWantsOuterSocks(vm) {
  return !!(vm?.proxy_cli_enabled && vm?.proxy && (vm.proxy.host || vm.proxy.url))
}

export function socksUidFor(vm) {
  const n = parseVmIndex(vm?.id) || parseVmIndex(vm?.name) || 1
  return String(10000 + n)
}

export function ensureOuterSocks(vm) {
  if (!vmWantsOuterSocks(vm)) return { ok: true, skipped: true }
  const r = sh(['/opt/kin-gateway/hypervisor/socks-egress.sh', 'setup', vm.id], { timeout: 20_000 })
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'outer socks setup failed' }
  return { ok: true, uid: socksUidFor(vm) }
}

function runtimeUser(vm) {
  return vmWantsOuterSocks(vm) ? `${socksUidFor(vm)}:${GID}` : `${UID}:${GID}`
}

function runtimeUidNum(vm) {
  return Number((runtimeUser(vm).split(':')[0]))
}

function runtimePatch(vm, info, extra = {}) {
  const kernel = vm.kernel || 'ubuntu-24.04'
  const meta = OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']
  vm.runtime = {
    type: RUNTIME,
    container: info?.name || containerName(vm.id),
    pid: info?.pid || null,
    ip: info?.ip || PUBLIC_IP,
    network: NET,
    network_mode: info?.networkMode || NET,
    started_at: info?.startedAt || extra.started_at || null,
    image: info?.image || meta.image,
    hostname: info?.hostname || displayName(vm.id),
    os: meta.pretty,
    memory: MEM,
    claude_code_version: vm.claude_code_version || CLAUDE_VER,
    egress: vmWantsOuterSocks(vm) ? 'outer-socks5' : 'host',
    ...extra,
  }
  return vm
}

export function startVmRuntime(vm, projectRoot, { recreate = false } = {}) {
  const name = containerName(vm.id)
  const host = displayName(vm.id)
  const kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.kernel = kernel
  vm.timezone = normalizeUsTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const image = imageForKernel(kernel)
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  if (vmWantsOuterSocks(vm)) {
    const ns = ensureOuterSocks(vm)
    if (!ns.ok) return { ok: false, error: ns.error }
  }
  try { fs.chownSync(home, runtimeUidNum(vm), Number(GID)) } catch {}

  let existing = inspectContainer(name)
  const wrongNet = existing && existing.networkMode !== NET
  const wrongImg = existing && existing.image !== image
  if (existing && (recreate || wrongNet || wrongImg)) {
    sh(['docker', 'rm', '-f', name])
    existing = null
  }
  if (existing?.running) {
    runtimePatch(vm, existing)
    return { ok: true, action: 'already-running', runtime: vm.runtime }
  }
  if (existing) {
    const r = sh(['docker', 'start', name])
    if (!r.ok) return { ok: false, error: r.stderr || 'docker start failed' }
    runtimePatch(vm, inspectContainer(name))
    return { ok: true, action: 'started', runtime: vm.runtime }
  }

  const nodePath = `${NODE_ROOT}/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  const args = [
    'docker', 'run', '-d',
    '--name', name,
    '--hostname', host,
    '--network', NET,
    '--restart', 'unless-stopped',
    '--memory', MEM,
    '--memory-swap', MEM,
    '--pids-limit', '256',
    '--user', runtimeUser(vm),
    '--label', 'kin.vm=1',
    '--label', `kin.vm.id=${vm.id}`,
    '--label', `kin.vm.name=${host}`,
    '--label', `kin.vm.os=${kernel}`,
    '-v', `${home}:/home/kincli`,
    '-v', `${NODE_ROOT}:${NODE_ROOT}:ro`,
    '-v', `${LIB_ROOT}:/opt/kin/lib:ro`,
    '-e', 'HOME=/home/kincli',
    '-e', 'CLAUDE_HOME=/home/kincli',
    '-e', 'CLAUDE_CONFIG_DIR=/home/kincli/.claude',
    '-e', `PATH=${nodePath}`,
    '-e', `TZ=${vm.timezone}`,
    '-e', `LANG=${vm.locale}`,
    '-e', `LC_ALL=${vm.locale}`,
    '-e', `KIN_VM_ID=${vm.id}`,
    '-e', `KIN_VM_NAME=${host}`,
    '-e', `KIN_VM_OS=${kernel}`,
    '--dns', '8.8.8.8',
    '--dns-opt', 'use-vc',
    '-w', '/home/kincli',
    image,
    'sleep', 'infinity',
  ]
  const r = sh(args, { timeout: 90_000 })
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'docker run failed' }
  runtimePatch(vm, inspectContainer(name), { container_id: r.stdout })
  return { ok: true, action: 'created', runtime: vm.runtime }
}

export function stopVmRuntime(vm) {
  const name = containerName(vm.id)
  const info = inspectContainer(name)
  if (!info) {
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true }
    return { ok: true, action: 'absent', runtime: vm.runtime || null }
  }
  if (!info.running) {
    runtimePatch(vm, info)
    vm.runtime.stopped = true
    return { ok: true, action: 'already-stopped', runtime: vm.runtime }
  }
  const r = sh(['docker', 'stop', '-t', '3', name])
  if (!r.ok) return { ok: false, error: r.stderr || 'docker stop failed' }
  runtimePatch(vm, inspectContainer(name))
  vm.runtime.stopped = true
  vm.runtime.pid = null
  return { ok: true, action: 'stopped', runtime: vm.runtime }
}

export function listRuntimeVms() {
  const r = sh([
    'docker', 'ps', '-a',
    '--filter', 'label=kin.vm=1',
    '--format', '{{.Names}}\t{{.Status}}\t{{.Label "kin.vm.id"}}\t{{.Label "kin.vm.os"}}',
  ])
  if (!r.ok || !r.stdout) return []
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, status, id, os] = line.split('\t')
    return { name, status, id, os }
  })
}
