/**
 * Slot identity rewrite for the Go worker HTTP data plane.
 *
 *   device_id     → slot (VM) device
 *   account_uuid  → real OAuth account of the slot
 *   session_id    → hash(account + caller session)
 *
 * Client settings/env/identity fields are always dropped.
 */
import crypto from 'node:crypto'
import { formatMetadataUserId } from './vm-identity.mjs'

export const IDENTITY_REPLACE = Object.freeze([
  'device_id',
  'account_uuid',
  'session_id_hash',
  'authorization',
  'fingerprint',
  'settings',
])

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

/**
 * Slot identity + caller-session hash:
 *   device_id    = slot device
 *   account_uuid = OAuth account
 *   session_id   = hash(account + caller session)
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
