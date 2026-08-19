/**
 * Real VM runtime: one Docker container per kin VM.
 * Mixed guest OS: Ubuntu 24.04 / Debian 12 / Arch / Fedora 41.
 * Go relay worker runs inside each container and explicitly dials the
 * slot-bound SOCKS5. A missing/unhealthy proxy fails closed.
 *
 * Host uid iptables REDIRECT (legacy gost) is not a second in-guest proxy.
 * The worker handshake to the real SOCKS listener must RETURN before that
 * REDIRECT, otherwise SOCKS greeting is reset by gost's redirect port.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureVmSocksExemption } from './socks-egress.mjs'

export const RUNTIME = 'docker'
const WORKER_BIN = process.env.KIN_WORKER_BIN || '/opt/kin-gateway/bin/kin-worker'
const GID = String(process.env.KIN_VM_GID || 987)
const MEM = process.env.KIN_VM_MEMORY || '768m'
const NET = process.env.KIN_VM_NETWORK || 'bridge'
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

export function ensureOuterSocks(vm, opts = {}) {
  if (!vmWantsOuterSocks(vm)) return { ok: false, error: 'slot SOCKS5 proxy is required' }
  const uid = socksUidFor(vm)
  const hijack = ensureVmSocksExemption(vm, { uid, run: opts.run, enabled: opts.enabled })
  if (!hijack.ok) return hijack
  return { ok: true, uid, transport: 'go-explicit-socks5', hijack }
}

function runtimeUser(vm) {
  return `${socksUidFor(vm)}:${GID}`
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
    user: runtimeUser(vm),
    worker: 'go',
    worker_socket: extra.worker_socket || vm.runtime?.worker_socket || null,
    worker_run_dir: extra.worker_run_dir || vm.runtime?.worker_run_dir || null,
    worker_token_file: extra.worker_token_file || vm.runtime?.worker_token_file || null,
    egress: 'explicit-socks5',
    egress_uid: runtimeUser(vm).split(':')[0],
    ...extra,
  }
  return vm
}

function workerPaths(projectRoot, vmId) {
  const slotRoot = path.join(projectRoot, 'vms', vmId)
  const runDir = path.join(slotRoot, 'run')
  return {
    slotRoot,
    runDir,
    socket: path.join(runDir, 'worker.sock'),
    token: path.join(runDir, 'internal.token'),
    config: path.join(runDir, 'worker.json'),
  }
}

function workerProxyUrl(vm) {
  if (!vmWantsOuterSocks(vm)) return null
  if (vm.proxy?.url) return String(vm.proxy.url).replace(/^socks5:\/\//i, 'socks5h://')
  if (!vm.proxy?.host || !vm.proxy?.port) return null
  const auth = vm.proxy.username
    ? `${encodeURIComponent(vm.proxy.username)}:${encodeURIComponent(vm.proxy.password || '')}@`
    : ''
  return `socks5h://${auth}${vm.proxy.host}:${vm.proxy.port}`
}

function writeWorkerFiles(vm, projectRoot) {
  const paths = workerPaths(projectRoot, vm.id)
  const uid = runtimeUidNum(vm)
  const gid = Number(GID)
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  let token = ''
  try { token = fs.readFileSync(paths.token, 'utf8').trim() } catch {}
  if (!token) token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(paths.token, token + '\n', { mode: 0o600 })
  const proxyUrl = workerProxyUrl(vm)
  if (!proxyUrl) throw new Error('slot SOCKS5 proxy is required')
  const workerConfig = {
    vm_id: vm.id,
    socket_path: '/run/kin/worker.sock',
    credential_path: '/home/kincli/.claude/credentials.json',
    proxy_url: proxyUrl,
    proxy_required: true,
    internal_token: token,
    delivery_mode: 'realtime',
    refresh_skew_seconds: 300,
    request_timeout_seconds: 180,
    first_byte_timeout_seconds: 30,
    idle_timeout_seconds: 60,
    max_request_bytes: 8 * 1024 * 1024,
    max_response_bytes: 64 * 1024 * 1024,
    max_event_bytes: 8 * 1024 * 1024,
  }
  fs.writeFileSync(paths.config, JSON.stringify(workerConfig, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chownSync(paths.runDir, uid, gid)
    fs.chownSync(paths.token, uid, gid)
    fs.chownSync(paths.config, uid, gid)
  } catch {}
  return paths
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
  const proxy = ensureOuterSocks(vm)
  if (!proxy.ok) return proxy
  if (!fs.existsSync(WORKER_BIN)) {
    return { ok: false, error: `Go worker binary not found: ${WORKER_BIN}` }
  }
  let worker
  try {
    worker = writeWorkerFiles(vm, projectRoot)
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
  try { fs.chownSync(home, runtimeUidNum(vm), Number(GID)) } catch {}
  const workerExtra = {
    worker_socket: worker.socket,
    worker_run_dir: worker.runDir,
    worker_token_file: worker.token,
    egress_hijack: proxy.hijack?.applied
      ? 'socks-dest-return'
      : (proxy.hijack?.skipped || proxy.hijack?.reason || null),
  }

  let existing = inspectContainer(name)
  const wrongNet = existing && existing.networkMode !== NET
  const wrongImg = existing && existing.image !== image
  const wrongWorker = existing && !fs.existsSync(worker.socket)
  if (existing && (recreate || wrongNet || wrongImg || wrongWorker)) {
    sh(['docker', 'rm', '-f', name])
    existing = null
  }
  if (existing?.running) {
    runtimePatch(vm, existing, workerExtra)
    return { ok: true, action: 'already-running', runtime: vm.runtime }
  }
  if (existing) {
    const r = sh(['docker', 'start', name])
    if (!r.ok) return { ok: false, error: r.stderr || 'docker start failed' }
    runtimePatch(vm, inspectContainer(name), workerExtra)
    return { ok: true, action: 'started', runtime: vm.runtime }
  }

  try { fs.rmSync(worker.socket, { force: true }) } catch {}
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
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--label', 'kin.vm=1',
    '--label', `kin.vm.id=${vm.id}`,
    '--label', `kin.vm.name=${host}`,
    '--label', `kin.vm.os=${kernel}`,
    '-v', `${home}:/home/kincli`,
    '-v', `${worker.runDir}:/run/kin`,
    '-v', `${WORKER_BIN}:/usr/local/bin/kin-worker:ro`,
    '-e', 'HOME=/home/kincli',
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
    '/usr/local/bin/kin-worker',
    '--config', '/run/kin/worker.json',
  ]
  const r = sh(args, { timeout: 90_000 })
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'docker run failed' }
  runtimePatch(vm, inspectContainer(name), {
    container_id: r.stdout,
    ...workerExtra,
  })
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
