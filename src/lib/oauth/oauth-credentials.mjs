/**
 * OAuth credential normalization + single-writer persistence.
 *
 * The per-slot Go worker is the ONLY refresh owner (grant_type=refresh_token
 * over the slot SOCKS5). The gateway never refreshes tokens itself; it only:
 *   1. imports credentials (admin sessionKey import → worker import API), and
 *   2. mirrors worker-rotated credentials into vm.json via `persistOauthToVm`.
 *
 * ONLY `persistOauthToVm` may write access_token/refresh_token into vm.json.
 */
import fs from 'node:fs'
import { atomicWriteJson } from '../vm/vm-file.mjs'

/** Kept for status / diagnostics only — refresh scheduling lives in the Go worker. */
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
  if (n.session_key) cfg.vm.session_key = n.session_key
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
  if (n.session_key) vm.claude.session_key = n.session_key
  if (cred?.mode) vm.claude.mode = cred.mode
  else if (!vm.claude.mode) vm.claude.mode = 'oauth'
  vm.claude.refresh_error = null
  vm.claude.refreshed_at = new Date().toISOString()
  vm.claude._token_version = Date.now()
  vm.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}
