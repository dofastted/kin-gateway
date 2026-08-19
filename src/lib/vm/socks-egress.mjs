/**
 * Host uid-owner NAT can still REDIRECT every TCP packet from a slot UID
 * (legacy gost wrap for Claude CLI). The Go worker now dials the slot SOCKS
 * itself. Those two layers must not stack:
 *
 *   1. 127.0.0.0/8 RETURN (local sockets)
 *   2. slot SOCKS host:port RETURN (worker handshake with the real proxy)
 *   3. remaining uid TCP REDIRECT → gost
 *
 * Guest has no proxy env. This is host wrap, not in-guest.
 * This module never installs the REDIRECT; it only keeps the SOCKS
 * destination in front of an existing one.
 */
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { listVms, getVm } from './vm-registry.mjs'

export const LOOPBACK_CIDR = '127.0.0.0/8'
const COMMENT_PREFIX = 'kin-socks-exempt'

export function iptablesExemptEnabled() {
  const raw = String(process.env.KIN_SOCKS_EGRESS_IPTABLES || '1').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

export function parseSocksEndpoint(raw) {
  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const normalized = /:\/\//.test(value) ? value.replace(/^socks5:\/\//i, 'socks5h://') : `socks5h://${value}`
    const u = new URL(normalized)
    const host = u.hostname
    const port = Number(u.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  } catch {
    return null
  }
}

export function socksEndpointFromVm(vm) {
  if (!vm?.proxy_cli_enabled) return null
  if (vm.proxy?.url) return parseSocksEndpoint(vm.proxy.url)
  const host = vm.proxy?.host
  const port = Number(vm.proxy?.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

export function parseNatOutputSave(text) {
  const rules = []
  for (const line of String(text || '').split(/\n/)) {
    const raw = line.trim()
    if (!raw.startsWith('-A OUTPUT')) continue
    rules.push({
      raw,
      spec: raw.replace(/^-A OUTPUT\s+/, ''),
      uid: matchArg(raw, /--uid-owner\s+(\S+)/),
      dest: matchArg(raw, /\s-d\s+(\S+)/),
      dport: numberArg(raw, /--dport\s+(\d+)/),
      jump: matchArg(raw, /\s-j\s+(\S+)/),
      toPorts: numberArg(raw, /--to-ports\s+(\d+)/),
      tcp: /\s-p\s+tcp\b/.test(raw),
    })
  }
  return rules
}

export function planUidSocksExemption({ uid, host, port, rules }) {
  const owner = String(uid)
  const destHost = stripCidr(host)
  const destPort = Number(port)
  if (!owner || !destHost || !Number.isInteger(destPort)) {
    return { needed: false, reason: 'invalid_endpoint', actions: [] }
  }
  const owned = (rules || []).map((rule, index) => ({ ...rule, index, line: index + 1 }))
    .filter((rule) => String(rule.uid) === owner && rule.tcp)
  const redirects = owned.filter((rule) => rule.jump === 'REDIRECT')
  if (!redirects.length) {
    return { needed: false, reason: 'no_uid_redirect', actions: [] }
  }
  const firstRedirect = redirects[0]
  const actions = []
  const loopbackReturn = owned.find((rule) => rule.jump === 'RETURN' && isLoopbackCidr(rule.dest) && !rule.dport)
  if (!loopbackReturn || loopbackReturn.line >= firstRedirect.line) {
    if (loopbackReturn && loopbackReturn.line >= firstRedirect.line) {
      actions.push(deleteAction(loopbackReturn))
    }
    actions.push(insertReturnAction({ uid: owner, dest: LOOPBACK_CIDR, at: firstRedirect.line }))
  }
  const socksReturn = owned.find((rule) => isSocksReturn(rule, destHost, destPort))
  const coveredByLoopback = isIpv4Loopback(destHost)
    && loopbackReturn
    && loopbackReturn.line < firstRedirect.line
  if (coveredByLoopback && !socksReturn) {
    return finalizePlan(actions, 'loopback_covers_socks')
  }
  if (socksReturn && socksReturn.line < firstRedirect.line) {
    return finalizePlan(actions, actions.length ? 'repair_loopback' : 'already_exempt')
  }
  if (socksReturn) actions.push(deleteAction(socksReturn))
  actions.push(insertReturnAction({ uid: owner, dest: destHost, dport: destPort, at: firstRedirect.line }))
  return finalizePlan(actions, socksReturn ? 'reorder_socks_return' : 'insert_socks_return')
}

export function ensureUidSocksExemption({
  uid,
  host,
  port,
  run = defaultRun,
  enabled = iptablesExemptEnabled(),
} = {}) {
  if (!enabled) return { ok: true, skipped: 'disabled' }
  const destHost = stripCidr(host)
  const destPort = Number(port)
  const listed = run(['iptables', '-t', 'nat', '-S', 'OUTPUT'])
  if (!listed.ok) {
    return unavailableResult(listed)
  }
  let rules = parseNatOutputSave(listed.stdout)
  let plan = planUidSocksExemption({ uid, host: destHost, port: destPort, rules })
  if (!plan.actions.length) {
    return { ok: true, skipped: plan.reason, uid: String(uid), host: destHost, port: destPort }
  }
  for (let i = 0; i < 4 && plan.actions.length; i++) {
    const action = plan.actions[0]
    const applied = run(['iptables', ...action.argv])
    if (!applied.ok) {
      return {
        ok: false,
        error: applied.stderr || applied.stdout || 'iptables exemption failed',
        uid: String(uid),
        host: destHost,
        port: destPort,
        reason: plan.reason,
      }
    }
    const again = run(['iptables', '-t', 'nat', '-S', 'OUTPUT'])
    if (!again.ok) return unavailableResult(again)
    rules = parseNatOutputSave(again.stdout)
    plan = planUidSocksExemption({ uid, host: destHost, port: destPort, rules })
  }
  if (plan.actions.length) {
    return {
      ok: false,
      error: 'uid SOCKS REDIRECT exemption did not stick',
      uid: String(uid),
      host: destHost,
      port: destPort,
    }
  }
  return { ok: true, applied: true, uid: String(uid), host: destHost, port: destPort, reason: plan.reason }
}

export function ensureVmSocksExemption(vm, opts = {}) {
  const endpoint = socksEndpointFromVm(vm)
  if (!endpoint) return { ok: false, error: 'slot SOCKS5 proxy is required' }
  const uid = opts.uid || null
  if (!uid) return { ok: false, error: 'slot uid is required' }
  return ensureUidSocksExemption({
    uid,
    host: endpoint.host,
    port: endpoint.port,
    run: opts.run,
    enabled: opts.enabled,
  })
}

export function ensureProjectSocksExemptions(projectRoot, { socksUidFor, run, enabled } = {}) {
  const results = []
  for (const summary of listVms(projectRoot)) {
    const vm = getVm(projectRoot, summary.id) || summary
    if (!vm?.proxy_cli_enabled || !vm.proxy) continue
    const uid = socksUidFor(vm)
    const result = ensureVmSocksExemption(vm, { uid, run, enabled })
    results.push({ vm_id: vm.id, uid, ...result })
    if (!result.ok && result.error === 'slot SOCKS5 proxy is required') continue
    if (!result.ok && !result.skipped) {
      return { ok: false, error: `${vm.id}: ${result.error}`, results }
    }
  }
  return { ok: true, results }
}

export function startSocksExemptScheduler({
  projectRoot,
  socksUidFor,
  intervalMs = 60_000,
  run,
} = {}) {
	const tick = () => {
		try {
			return ensureProjectSocksExemptions(projectRoot, { socksUidFor, run })
		} catch (error) {
			return { ok: false, error: String(error.message || error) }
		}
	}
	const first = tick()
	const timer = setInterval(tick, intervalMs)
	if (typeof timer.unref === 'function') timer.unref()
	return {
		stop() {
			clearInterval(timer)
		},
		first,
	}
}

function finalizePlan(actions, reason) {
  return { needed: actions.length > 0, reason, actions }
}

function isSocksReturn(rule, host, port) {
  if (rule.jump !== 'RETURN') return false
  if (Number(rule.dport) !== Number(port)) return false
  return stripCidr(rule.dest) === stripCidr(host)
}

function insertReturnAction({ uid, dest, dport, at }) {
  const argv = ['-t', 'nat', '-I', 'OUTPUT', String(at), '-m', 'owner', '--uid-owner', String(uid), '-p', 'tcp', '-d', dest]
  if (dport) argv.push('-m', 'tcp', '--dport', String(dport))
  argv.push('-m', 'comment', '--comment', `${COMMENT_PREFIX}:${uid}`, '-j', 'RETURN')
  return { type: 'insert', argv }
}

function deleteAction(rule) {
  return { type: 'delete', argv: ['-t', 'nat', '-D', 'OUTPUT', ...splitSpec(rule.spec)] }
}

function splitSpec(spec) {
  return String(spec || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []
}

function matchArg(raw, re) {
  const m = String(raw).match(re)
  return m ? m[1] : null
}

function numberArg(raw, re) {
  const v = matchArg(raw, re)
  return v == null ? null : Number(v)
}

function stripCidr(host) {
  return String(host || '').replace(/\/\d+$/, '')
}

function isLoopbackCidr(dest) {
  const value = String(dest || '')
  return value === LOOPBACK_CIDR || value === '127.0.0.0' || value.startsWith('127.0.0.0/')
}

function isIpv4Loopback(host) {
  if (host === 'localhost') return true
  const ip = stripCidr(host)
  if (!net.isIP(ip)) return false
  const n = ip.split('.').map((p) => Number(p))
  return n[0] === 127
}

function unavailableResult(listed) {
  const detail = String(listed.stderr || listed.stdout || '')
  if (/not found|ENOENT|No such file/i.test(detail)) {
    return { ok: true, skipped: 'iptables_unavailable' }
  }
  if (/Permission denied|Operation not permitted/i.test(detail)) {
    return { ok: true, skipped: 'iptables_unprivileged' }
  }
  return { ok: true, skipped: 'iptables_unavailable', error: detail || null }
}

function defaultRun(argv) {
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout || '').trim(), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
      code: error.status,
    }
  }
}
