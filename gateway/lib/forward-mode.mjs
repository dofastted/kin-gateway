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
 * Mode difference is nominal today: relay is a label with the SAME replace set
 * as cli. There is no independent HTTP relay — the Anthropic HTTP hop is
 * permanently 501 (see anthropic-messages.mjs), so both modes run the slot CLI.
 *
 * NOTE on where identity is enforced: for the `cli` transport the effective
 * identity comes from cli-home seeding (credentials/settings/fingerprint written
 * to the slot). The body-level metadata.user_id replace here is for audit and
 * consistency assertions; `claude -p` does not forward the body `metadata` to
 * api.anthropic.com verbatim.
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

export function applyForwardReplace(_mode, body, identity) {
  return applyVmStandardReplace(body, identity)
}
