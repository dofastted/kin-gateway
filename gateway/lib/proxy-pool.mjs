/**
 * SOCKS5 Proxy Pool
 * - Bulk import
 * - 1 proxy ↔ 1 VM binding
 * - Auto-assign free proxy on VM create
 * - Health probe every 5/10/30/60 min
 * - On failure: disable proxy + disable bound VM scheduling
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'

const DEFAULT_CONFIG = {
  probe_interval_min: 10, // 5 | 10 | 30 | 60
  probe_timeout_ms: 8000,
  max_failures: 2, // consecutive failures before disable
  enabled: true,
}

function uid(prefix = 'px') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
}

/** Parse line forms:
 *  socks5://user:pass@host:port
 *  host:port
 *  host:port:user:pass
 *  socks5://host:port
 */
export function parseSocks5Line(line) {
  const raw = String(line || '').trim()
  if (!raw || raw.startsWith('#')) return null
  try {
    if (/^socks5:\/\//i.test(raw)) {
      const u = new URL(raw)
      return {
        scheme: 'socks5',
        host: u.hostname,
        port: Number(u.port) || 1080,
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        raw,
      }
    }
    const parts = raw.split(':')
    if (parts.length === 2) {
      return {
        scheme: 'socks5',
        host: parts[0],
        port: Number(parts[1]),
        username: null,
        password: null,
        raw,
      }
    }
    if (parts.length >= 4) {
      const host = parts[0]
      const port = Number(parts[1])
      const username = parts[2]
      const password = parts.slice(3).join(':')
      return { scheme: 'socks5', host, port, username, password, raw }
    }
  } catch {
    return null
  }
  return null
}

export class ProxyPool {
  constructor({ dataDir, onDisableVm } = {}) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'proxy-pool.json')
    this.onDisableVm = onDisableVm // (vmId, reason) => void
    this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    this._timer = null
    this._probing = false
    this.load()
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.state.config = { ...DEFAULT_CONFIG, ...(this.state.config || {}) }
        if (!Array.isArray(this.state.proxies)) this.state.proxies = []
      }
    } catch {
      this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }

  snapshot() {
    const proxies = this.state.proxies
    const free = proxies.filter((p) => p.enabled && !p.bound_vm_id && p.status !== 'dead').length
    const bound = proxies.filter((p) => p.bound_vm_id).length
    const dead = proxies.filter((p) => !p.enabled || p.status === 'dead').length
    const ok = proxies.filter((p) => p.enabled && p.status === 'ok').length
    return {
      config: this.state.config,
      totals: {
        total: proxies.length,
        free,
        bound,
        ok,
        dead,
        probing: this._probing,
      },
      proxies: proxies.map((p) => this.publicProxy(p)),
    }
  }

  publicProxy(p) {
    return {
      id: p.id,
      host: p.host,
      port: p.port,
      has_auth: !!(p.username || p.password),
      status: p.status, // unknown | ok | fail | dead
      enabled: p.enabled,
      bound_vm_id: p.bound_vm_id || null,
      consecutive_failures: p.consecutive_failures || 0,
      latency_ms: p.latency_ms ?? null,
      last_probe_at: p.last_probe_at || null,
      last_error: p.last_error || null,
      created_at: p.created_at,
    }
  }

  importLines(text) {
    const lines = String(text || '').split(/\r?\n/)
    const added = []
    const skipped = []
    const existing = new Set(this.state.proxies.map((p) => `${p.host}:${p.port}:${p.username || ''}`))
    for (const line of lines) {
      const parsed = parseSocks5Line(line)
      if (!parsed || !parsed.host || !parsed.port) {
        if (line.trim()) skipped.push({ line: line.trim(), reason: 'parse_failed' })
        continue
      }
      const key = `${parsed.host}:${parsed.port}:${parsed.username || ''}`
      if (existing.has(key)) {
        skipped.push({ line: line.trim(), reason: 'duplicate' })
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

  /** Allocate one free healthy (or unknown) proxy and bind to vmId */
  allocateForVm(vmId) {
    if (!vmId) return null
    // already bound?
    const existing = this.state.proxies.find((p) => p.bound_vm_id === vmId && p.enabled)
    if (existing) return this.publicProxy(existing)

    const candidates = this.state.proxies.filter(
      (p) => p.enabled && !p.bound_vm_id && p.status !== 'dead' && p.status !== 'fail',
    )
    // prefer ok, then unknown
    candidates.sort((a, b) => {
      const score = (x) => (x.status === 'ok' ? 0 : x.status === 'unknown' ? 1 : 2)
      return score(a) - score(b)
    })
    const pick = candidates[0]
    if (!pick) return null
    pick.bound_vm_id = vmId
    this.save()
    return this.publicProxy(pick)
  }

  bind(proxyId, vmId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if (!p.enabled || p.status === 'dead') return { ok: false, error: 'proxy_disabled' }
    // unbind previous on this vm
    for (const x of this.state.proxies) {
      if (x.bound_vm_id === vmId && x.id !== proxyId) x.bound_vm_id = null
    }
    if (p.bound_vm_id && p.bound_vm_id !== vmId) {
      return { ok: false, error: 'proxy_already_bound', bound_vm_id: p.bound_vm_id }
    }
    p.bound_vm_id = vmId
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  unbind(proxyId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    p.bound_vm_id = null
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  unbindVm(vmId) {
    for (const p of this.state.proxies) {
      if (p.bound_vm_id === vmId) p.bound_vm_id = null
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
    this.save()
    this.restartScheduler()
    return { ok: true, config: this.state.config }
  }

  _cascadeDisableVm(proxy, reason) {
    if (!proxy.bound_vm_id) return
    const vmId = proxy.bound_vm_id
    if (typeof this.onDisableVm === 'function') {
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

  _applyProbeResult(p, result) {
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
        this._cascadeDisableVm(p, `proxy_probe_failed:${p.last_error}`)
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
    const p = this.state.proxies.find((x) => x.bound_vm_id === vmId && x.enabled && x.status !== 'dead')
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
    }
  }
}
