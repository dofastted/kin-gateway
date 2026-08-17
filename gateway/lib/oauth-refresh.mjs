/**
 * KIN OAuth lifecycle — alignment, not spoofing.
 *
 * sessionKey (CookieAuth) is import-only: it yields access_token + refresh_token.
 * Official Claude Code owns inference identity via credentials.json and is the
 * primary refresher. KIN only:
 *   1. harvests CLI-rotated tokens
 *   2. calls grant_type=refresh_token as a backup when the CLI is absent or
 *      the access token is fully expired
 * Never race the CLI for the same refresh_token (Anthropic rotates / one-time).
 */
import fs from 'node:fs'
import path from 'node:path'

async function defaultRefreshFn(refreshToken, opts) {
  const { refreshOAuthToken } = await import('../../session-to-oauth.mjs')
  return refreshOAuthToken(refreshToken, opts)
}

/** Match sub2api skew (~3m) with a bit more margin. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000

export function expiresAtToMs(expiresAt) {
  const n = Number(expiresAt) || 0
  if (!n) return 0
  return n < 10_000_000_000 ? n * 1000 : n
}

export function needsRefresh(expiresAt, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  const ms = expiresAtToMs(expiresAt)
  if (!ms) return true
  return ms - now <= skewMs
}

export function isFullyExpired(expiresAt, now = Date.now()) {
  const ms = expiresAtToMs(expiresAt)
  if (!ms) return true
  return ms <= now
}

/**
 * Keep on-disk CLI oauth when it is newer or is a same-window rotation.
 * Prevents writeCliHome from stomping a CLI-rotated refresh_token.
 */
export function shouldKeepCliOauth(existing, incoming) {
  if (!existing?.access_token && !existing?.refresh_token) return false
  const prevExp = expiresAtToMs(existing.expires_at)
  const nextExp = expiresAtToMs(incoming?.expires_at)
  if (prevExp > nextExp + 1000) return true
  const rtDiffer = !!(existing.refresh_token && incoming?.refresh_token && existing.refresh_token !== incoming.refresh_token)
  const atDiffer = !!(existing.access_token && incoming?.access_token && existing.access_token !== incoming.access_token)
  if ((rtDiffer || atDiffer) && prevExp + 60_000 >= nextExp) return true
  return false
}

export function normalizeOauth(cred = {}) {
  const access = cred.access_token || cred.accessToken || ''
  const refresh = cred.refresh_token || cred.refreshToken || ''
  let exp = cred.expires_at || cred.expiresAt || 0
  if (exp && exp > 10_000_000_000) exp = Math.floor(exp / 1000)
  if (!exp && cred.expires_in) exp = Math.floor(Date.now() / 1000) + Number(cred.expires_in)
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: exp || null,
    email: cred.email || cred.email_address || cred.emailAddress || null,
    account_uuid: cred.account_uuid || cred.accountUuid || null,
    org_uuid: cred.org_uuid || cred.orgUuid || null,
    scope: cred.scope || null,
    source: cred.source || null,
    _token_version: cred._token_version || cred.token_version || null,
  }
}

export function applyOauthToCfg(cfg, cred) {
  if (!cfg?.vm) return cfg
  const n = normalizeOauth(cred)
  if (n.access_token) cfg.vm.access_token = n.access_token
  if (n.refresh_token) cfg.vm.refresh_token = n.refresh_token
  if (n.expires_at) cfg.vm.expires_at = n.expires_at
  if (n.email) cfg.vm.email = n.email
  if (n.account_uuid) cfg.vm.account_uuid = n.account_uuid
  if (n.org_uuid) cfg.vm.org_uuid = n.org_uuid
  if (n._token_version) cfg.vm._token_version = n._token_version
  cfg.vm.refresh_error = null
  return cfg
}

export function persistOauthToVm(vmPath, cred) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const n = normalizeOauth(cred)
  vm.claude = { ...(vm.claude || {}) }
  if (n.access_token) vm.claude.access_token = n.access_token
  if (n.refresh_token) vm.claude.refresh_token = n.refresh_token
  if (n.expires_at) vm.claude.expires_at = n.expires_at
  if (n.email) vm.claude.email = n.email
  if (n.account_uuid) vm.claude.account_uuid = n.account_uuid
  if (n.org_uuid) vm.claude.org_uuid = n.org_uuid
  if (n.scope) vm.claude.scope = n.scope
  if (n.source) vm.claude.source = n.source
  vm.claude.refresh_error = null
  vm.claude.refreshed_at = new Date().toISOString()
  vm.claude._token_version = Date.now()
  vm.updated_at = new Date().toISOString()
  fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2), { mode: 0o600 })
  return vm
}

export function persistRefreshError(vmPath, err) {
  if (!vmPath || !fs.existsSync(vmPath)) return
  try {
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    vm.claude = { ...(vm.claude || {}) }
    vm.claude.refresh_error = {
      at: new Date().toISOString(),
      result: err?.result || 'error',
      message: String(err?.error || err?.message || err).slice(0, 300),
      need_reimport: !!err?.need_reimport,
    }
    vm.updated_at = new Date().toISOString()
    fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2), { mode: 0o600 })
  } catch {}
}

export function rereadVmOauth(cfg) {
  const vmPath = cfg?.vm?.path
  if (!vmPath || !fs.existsSync(vmPath)) return false
  try {
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const c = vm.claude || {}
    if (!c.access_token && !c.refresh_token) return false
    const beforeRt = cfg.vm.refresh_token
    const beforeAt = cfg.vm.access_token
    if (c.access_token) cfg.vm.access_token = c.access_token
    if (c.refresh_token) cfg.vm.refresh_token = c.refresh_token
    if (c.expires_at) cfg.vm.expires_at = c.expires_at
    if (c.email) cfg.vm.email = c.email
    cfg.vm.refresh_error = c.refresh_error || null
    cfg.vm._token_version = c._token_version || cfg.vm._token_version || null
    return beforeRt !== cfg.vm.refresh_token || beforeAt !== cfg.vm.access_token
  } catch {
    return false
  }
}

export function readCliOauth(homeDir) {
  if (!homeDir) return null
  const candidates = [
    path.join(homeDir, '.claude', 'credentials.json'),
    path.join(homeDir, '.claude', '.credentials.json'),
  ]
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const o = raw.claudeAiOauth || raw
      if (!o?.accessToken && !o?.access_token) continue
      return normalizeOauth({
        access_token: o.accessToken || o.access_token,
        refresh_token: o.refreshToken || o.refresh_token,
        expires_at: o.expiresAt || o.expires_at,
      })
    } catch {}
  }
  return null
}

export function createOauthGuard(cfg, deps = {}) {
  const refreshFn = deps.refreshFn || defaultRefreshFn
  let chain = Promise.resolve()
  let timer = null
  let last = { at: 0, result: 'idle' }

  function withLock(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  function status() {
    const exp = Number(cfg.vm?.expires_at) || 0
    const now = Math.floor(Date.now() / 1000)
    return {
      vm_id: cfg.vm?.id || null,
      has_access: !!cfg.vm?.access_token,
      has_refresh: !!cfg.vm?.refresh_token,
      expires_at: exp || null,
      ttl_sec: exp ? exp - now : null,
      needs_refresh: needsRefresh(cfg.vm?.expires_at),
      need_reimport: !!cfg.vm?.refresh_error?.need_reimport,
      last,
    }
  }

  function harvestFromHome(homeDir) {
    const harvested = readCliOauth(homeDir)
    if (!harvested?.access_token) return { harvested: false }
    const cur = expiresAtToMs(cfg.vm?.expires_at)
    const next = expiresAtToMs(harvested.expires_at)
    const rtChanged = !!(harvested.refresh_token && harvested.refresh_token !== cfg.vm?.refresh_token)
    const atChanged = !!(harvested.access_token && harvested.access_token !== cfg.vm?.access_token)
    if (next <= cur + 1000 && !rtChanged && !atChanged) return { harvested: false }
    harvested.source = 'cli-harvest'
    applyOauthToCfg(cfg, harvested)
    persistOauthToVm(cfg.vm.path, harvested)
    last = { at: Date.now(), result: 'harvested', expires_at: harvested.expires_at }
    return { harvested: true, expires_at: harvested.expires_at }
  }

  async function doRefresh({ force = false, homeDir = null } = {}) {
    rereadVmOauth(cfg)
    if (homeDir) {
      const h = harvestFromHome(homeDir)
      if (h.harvested && !force && !needsRefresh(cfg.vm?.expires_at)) {
        last = { at: Date.now(), result: 'harvested', expires_at: cfg.vm.expires_at }
        return { ok: true, refreshed: false, harvested: true, expires_at: cfg.vm.expires_at }
      }
    }
    if (!force && cfg.vm?.refresh_error?.need_reimport) {
      last = { at: Date.now(), result: 'need_reimport' }
      return { ok: false, refreshed: false, need_reimport: true, error: 'oauth_need_reimport' }
    }
    if (!force && !needsRefresh(cfg.vm?.expires_at)) {
      last = { at: Date.now(), result: 'fresh' }
      return { ok: true, refreshed: false, expires_at: cfg.vm.expires_at }
    }
    // Official CLI owns refresh while access is still valid. KIN calling
    // grant_type=refresh_token in the same window races and burns the token.
    if (!force && homeDir && !isFullyExpired(cfg.vm?.expires_at) && cfg.vm?.access_token) {
      last = { at: Date.now(), result: 'defer_to_cli', expires_at: cfg.vm.expires_at }
      return { ok: true, refreshed: false, defer_to_cli: true, expires_at: cfg.vm.expires_at }
    }
    const rt = cfg.vm?.refresh_token
    if (!rt) {
      const expired = needsRefresh(cfg.vm?.expires_at, Date.now(), 0)
      last = { at: Date.now(), result: 'no_refresh_token' }
      return { ok: !expired, refreshed: false, need_reimport: expired, error: 'no_refresh_token' }
    }
    try {
      // Refresh hits api.anthropic.com — do NOT send VM SOCKS (import-only).
      const cred = await refreshFn(rt, { proxyUrl: null })
      const n = normalizeOauth({ ...cred, source: 'refresh_token' })
      if (!n.access_token) throw new Error('refresh returned no access_token')
      if (!n.refresh_token) n.refresh_token = rt
      applyOauthToCfg(cfg, n)
      persistOauthToVm(cfg.vm.path, n)
      last = { at: Date.now(), result: 'refreshed', expires_at: n.expires_at }
      return { ok: true, refreshed: true, expires_at: n.expires_at }
    } catch (e) {
      const msg = String(e.message || e)
      const invalid = e.code === 'invalid_grant' || /invalid_grant|invalid.refresh|expired.*refresh/i.test(msg)
      last = { at: Date.now(), result: invalid ? 'invalid_grant' : 'error', error: msg.slice(0, 200) }
      persistRefreshError(cfg.vm?.path, { ...last, need_reimport: invalid })
      if (homeDir) {
        const h = harvestFromHome(homeDir)
        if (h.harvested) {
          return { ok: true, refreshed: false, harvested: true, expires_at: cfg.vm.expires_at }
        }
      }
      rereadVmOauth(cfg)
      if (invalid && cfg.vm?.refresh_token && cfg.vm.refresh_token !== rt) {
        last = { at: Date.now(), result: 'race_recovered' }
        return { ok: true, refreshed: false, harvested: true, expires_at: cfg.vm.expires_at }
      }
      if (invalid) cfg.vm.refresh_error = { need_reimport: true, result: 'invalid_grant', message: msg.slice(0, 200) }
      return { ok: false, refreshed: false, need_reimport: invalid, error: msg.slice(0, 300) }
    }
  }

  function ensureFresh(opts) {
    return withLock(() => doRefresh(opts))
  }

  function startLoop(intervalMs = 60_000, opts = {}) {
    if (timer) return
    timer = setInterval(() => {
      ensureFresh(opts).catch(() => {})
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopLoop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function noteImported(cred) {
    applyOauthToCfg(cfg, cred)
    last = { at: Date.now(), result: 'imported', expires_at: cfg.vm.expires_at }
  }

  return { ensureFresh, harvestFromHome, startLoop, stopLoop, status, noteImported }
}
