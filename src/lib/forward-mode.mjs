/**
 * Forward modes.
 *
 * relay (default): CRS HTTP from the VM UID.
 *   device_id     → VM only
 *   account_uuid  → CRS: real OAuth account
 *   session_id    → CRS: hash(account + caller session)
 *   env/fingerprint that can be swapped → VM
 *
 * cli (fallback): official `claude` on the slot. Full VM identity.
 */
import crypto from 'node:crypto'
import { formatMetadataUserId } from './vm-identity.mjs'

export const VM_STANDARD_REPLACE = Object.freeze([
  'credentials',
  'session_id',
  'device_id',
  'metadata.user_id',
  'characteristics',
  'fingerprint',
  'settings',
])

export const CRS_REPLACE = Object.freeze([
  'device_id',
  'account_uuid',
  'session_id_hash',
  'authorization',
  'fingerprint',
  'settings',
])

export const FORWARD_MODES = {
  relay: {
    id: 'relay',
    title: 'vm-crs-http',
    transport: 'relay',
    replace: CRS_REPLACE,
  },
  cli: {
    id: 'cli',
    title: 'vm-claude-code',
    transport: 'cli',
    replace: VM_STANDARD_REPLACE,
  },
}

export function resolveForwardMode(req = {}, inbound = {}) {
  const raw = String(
    req.headers?.['x-kin-forward'] ||
    inbound?.forward ||
    inbound?.forward_mode ||
    '',
  ).trim().toLowerCase()
  if (raw === 'cli' || raw === 'claude' || raw === 'claude-code' || raw === 'cliproxy') return 'cli'
  if (raw === 'relay' || raw === 'sub2api' || raw === 's2a' || raw === 'protocol' || raw === 'crs' || raw === 'http') return 'relay'
  return 'relay'
}

export function modeSpec(mode) {
  return FORWARD_MODES[mode] || FORWARD_MODES.relay
}

export function uuidFromSeed(seed) {
  const hex = crypto.createHash('sha256').update(String(seed || '')).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function parseUserId(raw) {
  if (!raw) return null
  if (typeof raw === 'object') {
    return {
      device_id: raw.device_id || raw.deviceId || '',
      account_uuid: raw.account_uuid || raw.accountUuid || '',
      session_id: raw.session_id || raw.sessionId || '',
    }
  }
  const s = String(raw)
  try {
    const p = JSON.parse(s)
    if (p && typeof p === 'object') {
      return {
        device_id: p.device_id || p.deviceId || '',
        account_uuid: p.account_uuid || p.accountUuid || '',
        session_id: p.session_id || p.sessionId || '',
      }
    }
  } catch {}
  const m = /^user_(.*?)_account_(.*?)_session_(.*)$/.exec(s)
  if (m) return { device_id: m[1], account_uuid: m[2], session_id: m[3] }
  return null
}

/** CLI fallback: drop caller identity, write full VM metadata.user_id. */
export function applyVmStandardReplace(body, identity) {
  const out = { ...(body || {}) }
  delete out.settings
  delete out.claude_settings
  delete out.env
  delete out.user
  delete out.user_id

  const md = {}
  if (out.metadata && typeof out.metadata === 'object') {
    for (const [k, v] of Object.entries(out.metadata)) {
      if (/user|machine|device|host|tz|timezone|locale|setting|session_source/i.test(k)) continue
      md[k] = v
    }
  }
  md.user_id = identity.metadataUserId
  out.metadata = md
  return out
}

/**
 * CRS + VM device:
 *   device_id    = VM
 *   account_uuid = OAuth account (CRS)
 *   session_id   = hash(account + caller session) (CRS)
 */
export function applyCrsIdentityReplace(body, identity, inbound = {}) {
  const out = { ...(body || {}) }
  delete out.settings
  delete out.claude_settings
  delete out.env
  delete out.user
  delete out.user_id

  const raw = inbound?.metadata?.user_id || body?.metadata?.user_id
  const parsed = parseUserId(raw) || {}
  const deviceId = identity.deviceId || identity.machineId || ''
  const accountUuid = identity.accountUuid || parsed.account_uuid || ''
  const origSession = parsed.session_id || crypto.randomUUID()
  const sessionId = uuidFromSeed(`${accountUuid || identity.vmId || 'vm'}::${origSession}`)

  const md = {}
  if (out.metadata && typeof out.metadata === 'object') {
    for (const [k, v] of Object.entries(out.metadata)) {
      if (/user|machine|device|host|tz|timezone|locale|setting|session_source/i.test(k)) continue
      md[k] = v
    }
  }
  md.user_id = formatMetadataUserId({ deviceId, accountUuid, sessionId })
  out.metadata = md
  return out
}

export function applyForwardReplace(mode, body, identity, inbound = {}) {
  if (mode === 'cli') return applyVmStandardReplace(body, identity)
  return applyCrsIdentityReplace(body, identity, inbound)
}

export function shouldFallbackToCli(result = {}) {
  if (result.ok) return false
  const st = Number(result.status) || 0
  if (st === 401 || st === 403) return false
  if (result.transportError) return true
  if (st === 529 || st === 0) return true
  if (st >= 500 && st !== 501) return true
  return false
}
