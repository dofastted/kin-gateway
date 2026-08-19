/**
 * Slot seed policy + inbound body sanitation.
 * The forwarding layer must never honor client-local settings/identity.
 */

/**
 * Strip client-local settings fingerprints from inbound body.
 * Forwarding layer must not honor client settings.json / machine metadata.
 */
export function sanitizeInboundBody(body, seedPolicy = {}) {
  if (!body || typeof body !== 'object') return body || {}
  const out = { ...body }
  const rejectMeta = seedPolicy.reject_client_metadata_identity !== false
  const rejectSettings = seedPolicy.reject_client_settings !== false
  if (rejectMeta && out.metadata && typeof out.metadata === 'object') {
    const md = { ...out.metadata }
    delete md.user_id
    delete md.userId
    delete md.machine_id
    delete md.machineId
    delete md.session_source
    const allow = {}
    for (const [k, v] of Object.entries(md)) {
      if (!/user|machine|device|host|tz|timezone|locale|setting/i.test(k)) allow[k] = v
    }
    if (Object.keys(allow).length) out.metadata = allow
    else delete out.metadata
  }
  if (rejectSettings) {
    delete out.settings
    delete out.claude_settings
    delete out.env
  }
  // OpenAI-compatible identity fields
  if (rejectMeta) {
    delete out.user
    delete out.user_id
  }
  return out
}

export function defaultSeedPolicy(partial = {}) {
  return {
    telemetry_disabled: partial.telemetry_disabled !== false,
    disable_nonessential_traffic: partial.disable_nonessential_traffic !== false,
    do_not_track: partial.do_not_track !== false,
    reject_client_settings: partial.reject_client_settings !== false,
    reject_client_metadata_identity: partial.reject_client_metadata_identity !== false,
    theme: partial.theme || 'dark',
    extra_env: partial.extra_env && typeof partial.extra_env === 'object' ? partial.extra_env : {},
    settings_json_override: partial.settings_json_override && typeof partial.settings_json_override === 'object'
      ? partial.settings_json_override
      : null,
  }
}
