/**
 * VM slot identity for official Messages hop.
 * Client settings/metadata are discarded; the scheduled VM is the only source.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

export function formatMetadataUserId({ deviceId, accountUuid, sessionId }) {
  return JSON.stringify({
    device_id: deviceId || '',
    account_uuid: accountUuid || '',
    session_id: sessionId || '',
  })
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex')
}

export function loadVmIdentity(exec = {}) {
  const home = exec.homeDir || ''
  const claudeDir = path.join(home, '.claude')
  const settings = readJsonSafe(path.join(claudeDir, 'settings.json'), {}) || {}
  const homeClaude = readJsonSafe(path.join(home, '.claude.json'), {}) || {}
  const dirClaude = readJsonSafe(path.join(claudeDir, '.claude.json'), {}) || {}
  const claudeJson = { ...dirClaude, ...homeClaude }
  const fp = exec.vm?.fingerprint || {}
  const oauth = exec.oauth || {}
  const seed = exec.seedPolicy || {}

  const machineId = claudeJson.machineID || ''
  const deviceId = /^[a-f0-9]{64}$/i.test(machineId)
    ? machineId
    : sha256Hex(fp.device_id || exec.vmId || 'kin-vm')
  const sessionId = fp.session_id || crypto.randomUUID()
  const accountUuid = oauth.account_uuid || claudeJson.oauthAccount?.accountUuid || ''
  const orgUuid = oauth.org_uuid || claudeJson.oauthAccount?.organizationUuid || ''
  const cliVersion = exec.vm?.claude_code_version || '2.1.233'

  const env = {
    DISABLE_TELEMETRY: seed.telemetry_disabled === false ? undefined : '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: seed.disable_nonessential_traffic === false ? undefined : '1',
    DO_NOT_TRACK: seed.do_not_track === false ? undefined : '1',
    TZ: exec.timezone || 'UTC',
    LANG: exec.locale || 'en_US.UTF-8',
    LC_ALL: exec.locale || 'en_US.UTF-8',
    ...(seed.extra_env || {}),
    ...(settings.env || {}),
  }
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k]

  const settingsOut = {
    ...(seed.settings_json_override && typeof seed.settings_json_override === 'object'
      ? seed.settings_json_override
      : {}),
    env,
    theme: seed.theme || settings.theme || 'dark',
    autoUpdates: false,
  }

  return {
    vmId: exec.vmId || null,
    cliVersion,
    timezone: exec.timezone || 'UTC',
    locale: exec.locale || 'en_US.UTF-8',
    kernel: exec.kernel || null,
    email: oauth.email || claudeJson.oauthAccount?.emailAddress || null,
    accountUuid,
    orgUuid,
    deviceId,
    sessionId,
    machineId: machineId || deviceId,
    userId: claudeJson.userID || null,
    displayName: claudeJson.oauthAccount?.displayName || null,
    settings: settingsOut,
    metadataUserId: formatMetadataUserId({ deviceId, accountUuid, sessionId }),
    userAgent: `claude-cli/${cliVersion} (external, cli)`,
    fingerprint: {
      device_id: fp.device_id || deviceId,
      session_id: sessionId,
      user_agent: fp.user_agent || `claude-cli/${cliVersion} (external, cli)`,
      stainless_lang: fp.stainless_lang || 'js',
      stainless_package_version: fp.stainless_package_version || '0.94.0',
      stainless_os: fp.stainless_os || 'Linux',
      stainless_arch: fp.stainless_arch || 'x64',
      stainless_runtime: fp.stainless_runtime || 'node',
      stainless_runtime_version: fp.stainless_runtime_version || 'v24.3.0',
      x_app: 'cli',
    },
  }
}

export function persistVmSettings(exec, identity) {
  if (!exec?.homeDir || !identity) return { wrote: false }
  const claudeDir = path.join(exec.homeDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(identity.settings, null, 2))
  fs.writeFileSync(path.join(claudeDir, 'kin-identity.json'), JSON.stringify({
    vm_id: identity.vmId,
    cli_version: identity.cliVersion,
    timezone: identity.timezone,
    locale: identity.locale,
    kernel: identity.kernel,
    account_uuid: identity.accountUuid,
    org_uuid: identity.orgUuid,
    device_id: identity.deviceId,
    session_id: identity.sessionId,
    written_at: new Date().toISOString(),
  }, null, 2))
  fs.writeFileSync(path.join(claudeDir, 'kin-seed.json'), JSON.stringify({
    pure: true,
    kernel: identity.kernel,
    timezone: identity.timezone,
    locale: identity.locale,
    telemetry: 'disabled',
    cli_version: identity.cliVersion,
    seeded_at: new Date().toISOString(),
  }, null, 2))
  return { wrote: true }
}

export function applyVmIdentityToBody(body, identity) {
  const out = { ...(body || {}) }
  const md = { ...(out.metadata && typeof out.metadata === 'object' ? out.metadata : {}) }
  md.user_id = identity.metadataUserId
  out.metadata = md
  return out
}

export function applyVmIdentityToHeaders(headers, identity, inbound = {}) {
  const h = { ...headers }
  h['user-agent'] = identity.userAgent
  h['x-claude-code-session-id'] = identity.sessionId
  if (!h['x-client-request-id'] && !inbound['x-client-request-id']) {
    h['x-client-request-id'] = crypto.randomUUID()
  }
  return h
}

/** Persist fingerprint onto vm.json only. Never touches oauth tokens. */
export function persistVmFingerprint(exec, identity) {
  if (!exec?.vmPath || !identity?.fingerprint) return { wrote: false }
  let vm
  try { vm = JSON.parse(fs.readFileSync(exec.vmPath, 'utf8')) } catch { return { wrote: false } }
  const prev = vm.fingerprint && typeof vm.fingerprint === 'object' ? vm.fingerprint : {}
  vm.fingerprint = {
    ...prev,
    ...identity.fingerprint,
    device_id: prev.device_id || identity.fingerprint.device_id,
    session_id: prev.session_id || identity.fingerprint.session_id,
    reset_at: prev.reset_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  fs.writeFileSync(exec.vmPath, JSON.stringify(vm, null, 2))
  if (exec.vm) exec.vm.fingerprint = vm.fingerprint
  return { wrote: true }
}
