/**
 * KIN forward modes — requirement source of truth.
 *
 * Consistency rule (hard):
 *   ALL caller characteristics are replaced by the scheduled VM slot's
 *   standard profile before outbound. No mixed identity.
 *
 * cli   (cliproxy / Claude Code on the VM)
 *   Transport: official `claude` on the slot.
 *   Identity: full VM standard replace (same set as relay).
 *
 * relay (sub2api-like protocol hop)
 *   Transport: official Messages shape.
 *   Identity: full VM standard replace.
 *
 * Mode difference is transport only, not what is replaced.
 *
 * VM standard profile:
 *   credentials, session_id, device_id, metadata.user_id,
 *   fingerprint (UA + x-stainless-* + x-app), settings, characteristics
 *   (timezone, locale, kernel, cli_version).
 *
 * Credentials are never refreshed here. Official CLI owns rotation.
 * Gateway only harvests and writes slot files.
 */

export const VM_STANDARD_REPLACE = Object.freeze([
  'credentials',
  'session_id',
  'device_id',
  'metadata.user_id',
  'characteristics',
  'fingerprint',
  'settings',
])

export const FORWARD_MODES = {
  cli: {
    id: 'cli',
    title: 'vm-claude-code',
    transport: 'cli',
    replace: VM_STANDARD_REPLACE,
  },
  relay: {
    id: 'relay',
    title: 'vm-protocol-relay',
    transport: 'relay',
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
  if (raw === 'relay' || raw === 'sub2api' || raw === 's2a' || raw === 'protocol') return 'relay'
  if (raw === 'cli' || raw === 'claude' || raw === 'claude-code' || raw === 'cliproxy') return 'cli'
  return 'cli'
}

export function modeSpec(mode) {
  return FORWARD_MODES[mode] || FORWARD_MODES.cli
}

/**
 * Full VM-standard identity replace.
 * Drops caller settings / machine identity; writes VM metadata.user_id.
 * Used by both cli and relay for consistency.
 */
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

/** @deprecated use applyVmStandardReplace */
export function applyCliReplace(body, identity) {
  return applyVmStandardReplace(body, identity)
}

/** @deprecated use applyVmStandardReplace */
export function applyRelayReplace(body, identity) {
  return applyVmStandardReplace(body, identity)
}

export function applyForwardReplace(_mode, body, identity) {
  return applyVmStandardReplace(body, identity)
}

/** Always apply VM fingerprint headers (both modes). */
export function applyVmFingerprintHeaders(headers, identity) {
  const fp = identity.fingerprint || {}
  return {
    ...headers,
    'user-agent': fp.user_agent || identity.userAgent,
    'x-app': fp.x_app || 'cli',
    'x-stainless-lang': fp.stainless_lang || 'js',
    'x-stainless-package-version': fp.stainless_package_version || '0.94.0',
    'x-stainless-os': fp.stainless_os || 'Linux',
    'x-stainless-arch': fp.stainless_arch || 'x64',
    'x-stainless-runtime': fp.stainless_runtime || 'node',
    'x-stainless-runtime-version': fp.stainless_runtime_version || 'v24.3.0',
    'x-claude-code-session-id': identity.sessionId,
  }
}

export function applyRelayFingerprintHeaders(headers, identity) {
  return applyVmFingerprintHeaders(headers, identity)
}

export function applyCliSessionHeader(headers, identity) {
  return applyVmFingerprintHeaders(headers, identity)
}
