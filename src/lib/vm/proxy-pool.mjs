/**
 * SOCKS5 Proxy Pool (SQLite-backed)
 * - Bulk import
 * - 1 proxy ↔ up to 5 VMs (`MAX_VMS_PER_PROXY`)
 * - Auto-assign a proxy with remaining capacity on VM create
 * - Health probe every 5/10/30/60 min
 * - On failure: disable proxy + disable bound VM scheduling
 *
 * Persistence: `proxies` table + `settings.proxy_pool_config`.
 * Working set stays in memory (probe loop mutates it); save() writes through.
 */
import net from 'node:net'
import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { ProxiesRepo } from '../db/repos/proxies-repo.mjs'

export const MAX_VMS_PER_PROXY = 5

const DEFAULT_CONFIG = {
  probe_interval_min: 10, // 5 | 10 | 30 | 60
  probe_timeout_ms: 8000,
  max_failures: 2, // consecutive failures before disable
  enabled: true,
  disconnect_on_error: false, // experimental: stop slot + tear SOCKS on runtime errors
}

export function parseBoundVmIds(value) {
  if (Array.isArray(value)) return normalizeVmIds(value)
  if (value && typeof value === 'object' && Array.isArray(value.ids)) return normalizeVmIds(value.ids)
  if (value == null || value === '') return []
  const raw = String(value).trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try { return normalizeVmIds(JSON.parse(raw)) } catch { return [] }
  }
  if (raw.includes(',')) return normalizeVmIds(raw.split(','))
  return normalizeVmIds([raw])
}

export function encodeBoundVmIds(ids) {
  const next = parseBoundVmIds(ids)
  if (!next.length) return null
  if (next.length === 1) return next[0]
  return JSON.stringify(next)
}

function normalizeVmIds(list) {
  const out = []
  const seen = new Set()
  for (const item of list || []) {
    const id = String(item || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_VMS_PER_PROXY) break
  }
  return out
}

export function boundVmIdsOf(proxy) {
  if (!proxy) return []
  if (Array.isArray(proxy.bound_vm_ids) && proxy.bound_vm_ids.length) {
    return parseBoundVmIds(proxy.bound_vm_ids)
  }
  return parseBoundVmIds(proxy.bound_vm_id)
}

export function proxyHasVm(proxy, vmId) {
  if (!proxy || !vmId) return false
  return boundVmIdsOf(proxy).includes(String(vmId))
}

function setBoundVmIds(proxy, ids) {
  const next = parseBoundVmIds(ids)
  proxy.bound_vm_ids = next
  proxy.bound_vm_id = next[0] || null
  return next
}

function hydrateProxy(proxy) {
  if (!proxy) return proxy
  const ids = parseBoundVmIds(proxy.bound_vm_ids?.length ? proxy.bound_vm_ids : proxy.bound_vm_id)
  return { ...proxy, bound_vm_ids: ids, bound_vm_id: ids[0] || null }
}

function uid(prefix = 'px') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
}

function isSocksPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function looksLikeHost(value) {
  const host = String(value || '').trim()
  if (!host || /^\d+$/.test(host)) return false
  return true
}

function socks5Record({ host, port, username = null, password = null, raw = '' }) {
  if (!looksLikeHost(host) || !isSocksPort(port)) return null
  const user = username == null || username === '' ? null : String(username)
  const pass = user == null
    ? null
    : (password == null ? '' : String(password))
  return {
    scheme: 'socks5',
    host: String(host).trim(),
    port: Number(port),
    username: user,
    password: pass,
    raw: String(raw || `${host}:${port}`),
  }
}

/** Structured host / port / username / password import. */
export function parseSocks5Fields(fields = {}) {
  return socks5Record({
    host: fields.host,
    port: fields.port,
    username: fields.username ?? fields.user,
    password: fields.password ?? fields.pass,
    raw: fields.raw,
  })
}

/** Parse line forms:
 *  socks5://user:pass@host:port
 *  socks5h://user:pass@host:port
 *  user:pass@host:port
 *  host:port
 *  host:port:user:pass
 *  user:pass:host:port
 */
export function parseSocks5Line(line) {
  let raw = String(line || '').trim()
  if (!raw || raw.startsWith('#')) return null
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  try {
    if (/^socks5h?:\/\//i.test(raw)) {
      const u = new URL(raw.replace(/^socks5h:\/\//i, 'socks5://'))
      return socks5Record({
        host: u.hostname,
        port: u.port || 1080,
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        raw,
      })
    }
    const at = raw.lastIndexOf('@')
    if (at > 0) {
      const cred = raw.slice(0, at)
      const hostPort = raw.slice(at + 1)
      const segs = hostPort.split(':')
      if (segs.length >= 2 && isSocksPort(segs[segs.length - 1])) {
        const port = segs.pop()
        const host = segs.join(':')
        const colon = cred.indexOf(':')
        return socks5Record({
          host,
          port,
          username: colon >= 0 ? cred.slice(0, colon) : cred,
          password: colon >= 0 ? cred.slice(colon + 1) : '',
          raw,
        })
      }
    }
    const parts = raw.split(':')
    if (parts.length === 2) {
      return socks5Record({ host: parts[0], port: parts[1], raw })
    }
    if (parts.length === 3 && looksLikeHost(parts[0]) && isSocksPort(parts[1])) {
      return socks5Record({ host: parts[0], port: parts[1], username: parts[2], password: '', raw })
    }
    if (parts.length >= 4 && looksLikeHost(parts[0]) && isSocksPort(parts[1])) {
      return socks5Record({
        host: parts[0],
        port: parts[1],
        username: parts[2],
        password: parts.slice(3).join(':'),
        raw,
      })
    }
    if (parts.length >= 4 && isSocksPort(parts[parts.length - 1]) && looksLikeHost(parts[parts.length - 2])) {
      return socks5Record({
        host: parts[parts.length - 2],
        port: parts[parts.length - 1],
        username: parts[0],
        password: parts.slice(1, parts.length - 2).join(':'),
        raw,
      })
    }
  } catch {
    return null
  }
  return null
}

export class ProxyPool {
  constructor({ dataDir, db, onDisableVm, onDisconnectVm } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ProxiesRepo(this.db)
    this.onDisableVm = onDisableVm // (vmId, reason, proxyId) => void
    this.onDisconnectVm = onDisconnectVm // (vmId, reason, proxyId) => void — experimental tear-down
    this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    this._timer = null
    this._probing = false
    this.load()
  }

  /** Re-read working set from DB (startup + post-restore). */
  load() {
    try {
      this.state.config = { ...DEFAULT_CONFIG, ...(this.repo.getConfig({}) || {}) }
      this.state.proxies = this.repo.loadAll().map(hydrateProxy)
    } catch {
      this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    }
  }

  reload() {
    this.load()
  }

  /** Re-bind to a fresh DB connection (after backup restore) and re-read. */
  rebind(db) {
    this.db = db
    this.repo = new ProxiesRepo(db)
    this.load()
  }

  save() {
    this.repo.setConfig(this.state.config)
    this.repo.replaceAll(this.state.proxies.map((p) => ({
      ...p,
      bound_vm_id: encodeBoundVmIds(boundVmIdsOf(p)),
    })))
  }

  snapshot() {
    const proxies = this.state.proxies
    const unused = proxies.filter((p) => p.enabled && boundVmIdsOf(p).length === 0 && p.status !== 'dead').length
    const open = proxies.filter((p) => p.enabled && p.status !== 'dead' && boundVmIdsOf(p).length < MAX_VMS_PER_PROXY).length
    const bound = proxies.filter((p) => boundVmIdsOf(p).length > 0).length
    const dead = proxies.filter((p) => !p.enabled || p.status === 'dead').length
    const ok = proxies.filter((p) => p.enabled && p.status === 'ok').length
    const slotsUsed = proxies.reduce((n, p) => n + boundVmIdsOf(p).length, 0)
    return {
      config: { ...this.state.config, bind_limit: MAX_VMS_PER_PROXY },
      totals: {
        total: proxies.length,
        free: unused,
        open,
        bound,
        ok,
        dead,
        probing: this._probing,
        slots_used: slotsUsed,
        slots_cap: proxies.length * MAX_VMS_PER_PROXY,
        bind_limit: MAX_VMS_PER_PROXY,
      },
      proxies: proxies.map((p) => this.publicProxy(p)),
    }
  }

  publicProxy(p) {
    const ids = boundVmIdsOf(p)
    return {
      id: p.id,
      host: p.host,
      port: p.port,
      has_auth: !!(p.username || p.password),
      status: p.status, // unknown | ok | fail | dead
      enabled: p.enabled,
      bound_vm_id: ids[0] || null,
      bound_vm_ids: ids,
      bound_count: ids.length,
      bind_limit: MAX_VMS_PER_PROXY,
      consecutive_failures: p.consecutive_failures || 0,
      latency_ms: p.latency_ms ?? null,
      last_probe_at: p.last_probe_at || null,
      last_error: p.last_error || null,
      created_at: p.created_at,
    }
  }

  importLines(text, extra = {}) {
    const parsed = []
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!String(line || '').trim()) continue
      parsed.push(parseSocks5Line(line) || { __invalid: String(line).trim() })
    }
    const fields = extra.fields || extra.proxies || extra.entries || []
    for (const item of Array.isArray(fields) ? fields : [fields]) {
      if (!item || typeof item !== 'object') continue
      parsed.push(parseSocks5Fields(item) || { __invalid: `${item.host || ''}:${item.port || ''}` })
    }
    if (extra.host || extra.port) {
      parsed.push(parseSocks5Fields(extra) || { __invalid: `${extra.host || ''}:${extra.port || ''}` })
    }
    return this.importParsed(parsed)
  }

  importParsed(records = []) {
    const added = []
    const skipped = []
    const existing = new Set(this.state.proxies.map((p) => `${p.host}:${p.port}:${p.username || ''}`))
    for (const parsed of records) {
      if (!parsed || parsed.__invalid || !parsed.host || !parsed.port) {
        const label = parsed?.__invalid || ''
        if (label) skipped.push({ line: label, reason: 'parse_failed' })
        continue
      }
      const key = `${parsed.host}:${parsed.port}:${parsed.username || ''}`
      if (existing.has(key)) {
        skipped.push({ line: `${parsed.host}:${parsed.port}`, reason: 'duplicate' })
        continue
      }
      existing.add(key)
      const proxy = {
        id: uid('px'),
        scheme: 'socks5',
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        raw: parsed.raw,
        status: 'unknown',
        enabled: true,
        bound_vm_id: null,
        bound_vm_ids: [],
        consecutive_failures: 0,
        latency_ms: null,
        last_probe_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
      }
      this.state.proxies.push(proxy)
      added.push(this.publicProxy(proxy))
    }
    this.save()
    return { added: added.length, skipped: skipped.length, items: added, skip_details: skipped.slice(0, 20) }
  }

  /**
   * Restore pool↔VM binding after start/restart.
   * Prefer an existing bind, then the VM's last proxy id, then a free allocate.
   */
  ensureBoundToVm(vmId, preferredId = null) {
    if (!vmId) return null
    const existing = this.getProxyForVm(vmId)
    if (existing) return existing
    if (preferredId) {
      const bound = this.bind(preferredId, vmId)
      if (bound.ok) return this.getProxyForVm(vmId)
    }
    return this.allocateForVm(vmId)
  }

  /** Allocate one healthy proxy with remaining capacity and bind to vmId */
  allocateForVm(vmId) {
    if (!vmId) return null
    const existing = this.state.proxies.find((p) => p.enabled && proxyHasVm(p, vmId))
    if (existing) return this.publicProxy(existing)

    const candidates = this.state.proxies.filter(
      (p) => p.enabled && p.status !== 'dead' && p.status !== 'fail' && boundVmIdsOf(p).length < MAX_VMS_PER_PROXY,
    )
    candidates.sort((a, b) => {
      const score = (x) => (x.status === 'ok' ? 0 : x.status === 'unknown' ? 1 : 2)
      if (score(a) !== score(b)) return score(a) - score(b)
      return boundVmIdsOf(a).length - boundVmIdsOf(b).length
    })
    const pick = candidates[0]
    if (!pick) return null
    const bound = this.bind(pick.id, vmId)
    return bound.ok ? bound.proxy : null
  }

  bind(proxyId, vmId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (!p.enabled || p.status === 'dead') return { ok: false, error: 'proxy_disabled' }
    const vm = String(vmId || '').trim()
    if (!vm) return { ok: false, error: 'vm_id_required' }
    for (const x of this.state.proxies) {
      if (x.id === proxyId) continue
      const ids = boundVmIdsOf(x)
      if (ids.includes(vm)) setBoundVmIds(x, ids.filter((id) => id !== vm))
    }
    const ids = boundVmIdsOf(p)
    if (ids.includes(vm)) {
      this.save()
      return { ok: true, proxy: this.publicProxy(p) }
    }
    if (ids.length >= MAX_VMS_PER_PROXY) {
      return { ok: false, error: 'proxy_bind_limit', max: MAX_VMS_PER_PROXY, bound_vm_ids: ids }
    }
    setBoundVmIds(p, [...ids, vm])
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  unbind(proxyId, vmId = null) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const ids = boundVmIdsOf(p)
    const target = vmId == null || vmId === '' ? null : String(vmId).trim()
    const removed = target ? ids.filter((id) => id === target) : ids.slice()
    setBoundVmIds(p, target ? ids.filter((id) => id !== target) : [])
    this.save()
    return { ok: true, proxy: this.publicProxy(p), unbound_vm_ids: removed }
  }

  unbindVm(vmId) {
    const vm = String(vmId || '').trim()
    if (!vm) return
    for (const p of this.state.proxies) {
      const ids = boundVmIdsOf(p)
      if (ids.includes(vm)) setBoundVmIds(p, ids.filter((id) => id !== vm))
    }
    this.save()
  }

  setEnabled(proxyId, enabled) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    p.enabled = !!enabled
    if (!enabled) {
      p.status = 'dead'
      this._cascadeDisableVm(p, 'proxy_manually_disabled')
    } else {
      p.status = 'unknown'
      p.consecutive_failures = 0
      p.last_error = null
    }
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  remove(proxyId) {
    const idx = this.state.proxies.findIndex((x) => x.id === proxyId)
    if (idx < 0) return { ok: false, error: 'proxy_not_found' }
    const [p] = this.state.proxies.splice(idx, 1)
    this.save()
    return { ok: true, removed: this.publicProxy(p) }
  }

  updateConfig(patch = {}) {
    const allowed = [5, 10, 30, 60]
    if (patch.probe_interval_min != null) {
      const n = Number(patch.probe_interval_min)
      if (!allowed.includes(n)) {
        return { ok: false, error: 'invalid_interval', allowed }
      }
      this.state.config.probe_interval_min = n
    }
    if (patch.probe_timeout_ms != null) {
      this.state.config.probe_timeout_ms = Math.max(1000, Number(patch.probe_timeout_ms) || 8000)
    }
    if (patch.max_failures != null) {
      this.state.config.max_failures = Math.max(1, Number(patch.max_failures) || 2)
    }
    if (patch.enabled != null) this.state.config.enabled = !!patch.enabled
    if (patch.disconnect_on_error != null) this.state.config.disconnect_on_error = !!patch.disconnect_on_error
    this.save()
    this.restartScheduler()
    return { ok: true, config: this.state.config }
  }

  disconnectOnErrorEnabled() {
    return !!this.state.config.disconnect_on_error
  }

  /**
   * Runtime SOCKS5 failure from a live request.
   * When disconnect_on_error is off this is a no-op (existing cooldown/failover stays).
   */
  reportRuntimeFailure(vmId, error = 'runtime_socks_failure') {
    if (!this.disconnectOnErrorEnabled()) {
      return { ok: true, skipped: true, reason: 'disconnect_on_error_disabled' }
    }
    if (!vmId) return { ok: false, error: 'vm_id_required' }
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId))
    if (!p) return { ok: false, error: 'no_bound_proxy' }
    this._applyProbeResult(p, {
      ok: false,
      latency_ms: p.latency_ms ?? null,
      error: String(error || 'runtime_socks_failure'),
    }, { cascade: false })
    this._cascadeDisconnectVm(p, `proxy_disconnect:${p.last_error || error}`)
    this.save()
    return { ok: true, skipped: false, proxy: this.publicProxy(p) }
  }

  _cascadeDisconnectVm(proxy, reason) {
    const cb = this.onDisconnectVm || this.onDisableVm
    if (typeof cb !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        cb(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  _cascadeDisableVm(proxy, reason) {
    if (typeof this.onDisableVm !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        this.onDisableVm(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * TCP connect probe to host:port (SOCKS5 handshake optional lightweight).
   * Full SOCKS5 auth handshake is best-effort.
   */
  async probeOne(proxy) {
    const timeout = this.state.config.probe_timeout_ms || 8000
    const started = Date.now()
    return new Promise((resolve) => {
      const socket = net.connect({ host: proxy.host, port: proxy.port })
      let done = false
      const finish = (ok, error) => {
        if (done) return
        done = true
        try {
          socket.destroy()
        } catch {
          /* */
        }
        resolve({
          ok,
          latency_ms: Date.now() - started,
          error: error || null,
        })
      }
      socket.setTimeout(timeout)
      socket.on('connect', () => {
        // minimal SOCKS5 greeting
        // ver=5, nmethods=1, method=0 (no auth) or 2 (user/pass)
        const method = proxy.username ? 0x02 : 0x00
        const buf = Buffer.from([0x05, 0x01, method])
        socket.write(buf)
      })
      socket.on('data', (data) => {
        // expect 0x05 0x00 or 0x05 0x02
        if (data.length >= 2 && data[0] === 0x05) {
          if (data[1] === 0x00 || data[1] === 0x02 || data[1] === 0xff) {
            // 0xff = no acceptable methods — still proves SOCKS5 is talking
            finish(data[1] !== 0xff, data[1] === 0xff ? 'no_acceptable_auth_method' : null)
            return
          }
        }
        finish(true, null) // connected & got data
      })
      socket.on('timeout', () => finish(false, 'timeout'))
      socket.on('error', (e) => finish(false, String(e.message || e)))
      socket.on('close', () => {
        if (!done) finish(false, 'connection_closed')
      })
    })
  }

  async probeById(proxyId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const result = await this.probeOne(p)
    this._applyProbeResult(p, result)
    this.save()
    return { ok: true, proxy: this.publicProxy(p), probe: result }
  }

  async probeAll({ onlyEnabled = true } = {}) {
    if (this._probing) return { ok: false, error: 'probe_in_progress' }
    this._probing = true
    const results = []
    try {
      const list = this.state.proxies.filter((p) => (onlyEnabled ? p.enabled : true))
      for (const p of list) {
        const result = await this.probeOne(p)
        this._applyProbeResult(p, result)
        results.push({ id: p.id, ...result, status: p.status, enabled: p.enabled })
      }
      this.save()
      return { ok: true, total: results.length, results }
    } finally {
      this._probing = false
    }
  }

  _applyProbeResult(p, result, { cascade = true } = {}) {
    p.last_probe_at = new Date().toISOString()
    p.latency_ms = result.latency_ms
    if (result.ok) {
      p.status = 'ok'
      p.consecutive_failures = 0
      p.last_error = null
    } else {
      p.consecutive_failures = (p.consecutive_failures || 0) + 1
      p.last_error = result.error || 'probe_failed'
      p.status = 'fail'
      const maxFail = this.state.config.max_failures || 2
      if (p.consecutive_failures >= maxFail) {
        p.enabled = false
        p.status = 'dead'
        if (cascade) this._cascadeDisableVm(p, `proxy_probe_failed:${p.last_error}`)
      }
    }
  }

  startScheduler() {
    this.stopScheduler()
    if (!this.state.config.enabled) return
    const min = this.state.config.probe_interval_min || 10
    const ms = min * 60 * 1000
    this._timer = setInterval(() => {
      this.probeAll({ onlyEnabled: true }).catch(() => {})
    }, ms)
    // optional: don't block startup with immediate full probe
  }

  stopScheduler() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  restartScheduler() {
    this.startScheduler()
  }

  /** For upstream: get socks URL for a VM */
  getProxyForVm(vmId) {
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId) && x.enabled && x.status !== 'dead')
    if (!p) return null
    const auth =
      p.username != null
        ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@`
        : ''
    return {
      id: p.id,
      url: `socks5://${auth}${p.host}:${p.port}`,
      host: p.host,
      port: p.port,
      username: p.username || null,
      password: p.password == null ? null : p.password,
    }
  }
}
