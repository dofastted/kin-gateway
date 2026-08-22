/**
 * OAuth credential normalization + metadata persistence.
 *
 * The per-slot Go worker is the ONLY secret owner (credentials.json) and the
 * ONLY refresh owner (grant_type=refresh_token over slot SOCKS5).
 * Node / vm.json / SQLite / panel keep metadata only — never live tokens.
 *
 * persistOauthToVm writes presence flags + expiry/identity, then strips
 * access_token / refresh_token / session_key from the VM record.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'

export const REFRESH_SKEW_MS = 5 * 60 * 1000

export const SENSITIVE_CREDENTIAL_KEYS = [
  'access_token', 'refresh_token', 'session_key',
  'accessToken', 'refreshToken', 'sessionKey',
  'id_token', 'idToken',
]

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
    session_key: cred.session_key || cred.sessionKey || null,
    _token_version: cred._token_version || cred.token_version || cred.kinGeneration || cred.kin_generation || null,
  }
}

export function hasAccessPresence(claude = {}) {
  return !!(claude.has_access || claude.access_token || claude.accessToken)
}

export function hasRefreshPresence(claude = {}) {
  return !!(claude.has_refresh || claude.refresh_token || claude.refreshToken)
}

export function hasCredentialPresence(claude = {}) {
  return hasAccessPresence(claude) || hasRefreshPresence(claude)
}

export function stripCredentialSecrets(claude = {}) {
  const out = { ...claude }
  for (const key of SENSITIVE_CREDENTIAL_KEYS) delete out[key]
  return out
}

/** Metadata-only apply. Never copies live tokens onto cfg. */
export function applyOauthToCfg(cfg, cred) {
  if (!cfg?.vm) return cfg
  const n = normalizeOauth(cred)
  if (n.expires_at) cfg.vm.expires_at = n.expires_at
  if (n.email) cfg.vm.email = n.email
  if (n.account_uuid) cfg.vm.account_uuid = n.account_uuid
  if (n.org_uuid) cfg.vm.org_uuid = n.org_uuid
  cfg.vm.has_access = !!(n.access_token || cred.has_access || cfg.vm.has_access)
  cfg.vm.has_refresh = !!(n.refresh_token || cred.has_refresh || cfg.vm.has_refresh)
  cfg.vm.refresh_error = null
  delete cfg.vm.access_token
  delete cfg.vm.refresh_token
  delete cfg.vm.session_key
  return cfg
}

/** The Go worker's only credential file. Never the leftover `.credentials.json`. */
export function slotWorkerCredentialPath(homeDir) {
  if (!homeDir) return null
  return path.join(homeDir, '.claude', 'credentials.json')
}

/** Read the slot worker credentials.json without logging secrets. */
export function readWorkerCredentialFile(homeDir) {
  const file = slotWorkerCredentialPath(homeDir)
  if (!file) return null
  try {
    if (!fs.existsSync(file)) return null
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const oauth = doc?.claudeAiOauth && typeof doc.claudeAiOauth === 'object' ? doc.claudeAiOauth : doc
    if (!oauth || typeof oauth !== 'object') return null
    return {
      access_token: oauth.accessToken || oauth.access_token || '',
      refresh_token: oauth.refreshToken || oauth.refresh_token || '',
      expires_at: oauth.expiresAt || oauth.expires_at || null,
      email: oauth.email || oauth.emailAddress || oauth.email_address || null,
      account_uuid: oauth.accountUuid || oauth.account_uuid || null,
      org_uuid: oauth.orgUuid || oauth.org_uuid || null,
      scope: Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : (oauth.scope || null),
      source: 'go-slot-worker',
      _token_version: oauth.kinGeneration || oauth.kin_generation || null,
    }
  } catch {
    return null
  }
}

/** Metadata only — never tokens. Identity/scheduler must use this location. */
export function readSlotCredentialIdentity(homeDir) {
  const cred = readWorkerCredentialFile(homeDir)
  if (!cred) return null
  return {
    account_uuid: cred.account_uuid || null,
    org_uuid: cred.org_uuid || null,
    email: cred.email || null,
    has_access: !!cred.access_token,
    has_refresh: !!cred.refresh_token,
    expires_at: cred.expires_at || null,
    source: 'slot-credentials.json',
  }
}

/**
 * After the Go worker rotates tokens, mirror metadata (not secrets) into vm.json.
 */
export function mirrorWorkerCredentialsToVm(vmPath, homeDir) {
  const cred = readWorkerCredentialFile(homeDir)
  if (!cred?.access_token && !cred?.refresh_token) return null
  return persistOauthToVm(vmPath, cred)
}

/**
 * Reset leftover oauth_cleared / oauth_* / no_credential after a live
 * credential is written. Operator `disabled` and explicit `stopped` stay.
 */
export function restoreScheduleAfterLiveCredential(vm) {
  if (!vm || !hasCredentialPresence(vm.claude)) return vm
  const reason = String(vm.schedule_disabled_reason || '')
  if (!(reason === 'oauth_cleared' || reason === 'no_credential' || /^oauth_/.test(reason))) {
    return vm
  }
  vm.schedule_disabled_reason = null
  vm.schedulable = true
  const status = String(vm.status || '').toLowerCase()
  if (status === 'stopped' || status === 'paused' || status === 'disabled') {
    vm.status = 'running'
  }
  return vm
}

export function persistOauthToVm(vmPath, cred) {
  if (!vmPath || !fs.existsSync(vmPath)) return null
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const n = normalizeOauth(cred)
  vm.claude = stripCredentialSecrets({ ...(vm.claude || {}) })
  if (n.access_token || cred.has_access) vm.claude.has_access = true
  if (n.refresh_token || cred.has_refresh) vm.claude.has_refresh = true
  if (n.expires_at) vm.claude.expires_at = n.expires_at
  if (n.email) vm.claude.email = n.email
  if (n.account_uuid) vm.claude.account_uuid = n.account_uuid
  if (n.org_uuid) vm.claude.org_uuid = n.org_uuid
  if (n.scope) vm.claude.scope = n.scope
  if (n.source) vm.claude.source = n.source
  if (cred?.mode) vm.claude.mode = cred.mode
  else if (!vm.claude.mode) vm.claude.mode = 'oauth'
  vm.claude.refresh_error = null
  vm.claude.refreshed_at = new Date().toISOString()
  vm.claude._token_version = n._token_version || Date.now()
  restoreScheduleAfterLiveCredential(vm)
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}
