/**
 * Probe OAuth / usage FROM the VM official Claude Code.
 * Gateway never calls api.anthropic.com (no spoofed UA, no Bearer hop).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { readCliOauth } from './oauth-refresh.mjs'

export const AUTH_STATUS_TIMEOUT_MS = 20_000
export const HOP_PROBE_TIMEOUT_MS = 60_000

export function parseJsonFromCli(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {}
  }
  return null
}

export function normalizeCliAuthStatus(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    loggedIn: !!raw.loggedIn,
    authMethod: raw.authMethod || null,
    apiProvider: raw.apiProvider || null,
    email: raw.email || null,
    orgId: raw.orgId || raw.org_id || null,
    orgName: raw.orgName || raw.org_name || null,
    subscriptionType: raw.subscriptionType || raw.subscription_type || null,
  }
}

export function consumeCliNdjson(line, acc = {}) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return acc
  }
  const t = obj?.type
  if (t === 'rate_limit_event' && obj.rate_limit_info) {
    acc.rate_limits = acc.rate_limits || []
    acc.rate_limits.push(obj.rate_limit_info)
    acc.rate_limit = obj.rate_limit_info
  }
  if (t === 'result') {
    acc.result = obj
    if (typeof obj.result === 'string') acc.text = obj.result
    if (obj.usage) acc.usage = obj.usage
    if (obj.is_error) acc.error = obj
  }
  if (t === 'error' || obj.error) {
    acc.error = obj.error || obj
  }
  return acc
}

export function epochToIso(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toISOString()
}

export function quotaWindowsFromRateLimits(list) {
  const out = { five_hour: null, seven_day: null }
  for (const info of list || []) {
    if (!info || typeof info !== 'object') continue
    const typ = String(info.rateLimitType || info.rate_limit_type || '')
    const key = typ === 'seven_day' || typ === '7d' ? 'seven_day'
      : typ === 'five_hour' || typ === '5h' ? 'five_hour'
        : null
    if (!key) continue
    out[key] = {
      utilization: null,
      utilization_pct: null,
      resets_at: epochToIso(info.resetsAt ?? info.resets_at),
      status: info.status || null,
      rate_limit_type: typ,
      overage_status: info.overageStatus || info.overage_status || null,
      is_using_overage: !!(info.isUsingOverage ?? info.is_using_overage),
    }
  }
  return out
}

function kincliEnv(homeDir) {
  const env = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: homeDir,
    USER: 'kincli',
    LOGNAME: 'kincli',
    SHELL: '/bin/bash',
    CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DO_NOT_TRACK: '1',
  }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

/**
 * Official: `claude auth status --json` as kincli with VM HOME.
 * Does not hit Anthropic token endpoints from the gateway.
 */
export function runClaudeAuthStatus({ homeDir, timeoutMs = AUTH_STATUS_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!homeDir) {
      resolve({ ok: false, source: 'claude_auth_status', error: 'no_home_dir' })
      return
    }
    const child = spawn('sudo', ['-u', 'kincli', '-E', '--', 'claude', 'auth', 'status', '--json'], {
      env: kincliEnv(homeDir),
      cwd: homeDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        source: 'claude_auth_status',
        error: String(err.message || err),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const raw = parseJsonFromCli(stdout)
      const auth = normalizeCliAuthStatus(raw)
      if (killed) {
        resolve({ ok: false, source: 'claude_auth_status', error: `timeout after ${timeoutMs}ms` })
        return
      }
      if (!auth) {
        resolve({
          ok: false,
          source: 'claude_auth_status',
          error: (stderr || stdout || `exit ${code}`).trim().slice(0, 300),
          exit_code: code,
        })
        return
      }
      resolve({
        ok: true,
        source: 'claude_auth_status',
        ...auth,
        exit_code: code,
      })
    })
  })
}

/**
 * Tiny official `claude -p` hop. Harvests stream-json `rate_limit_event`.
 * Same identity / credentials as production hops. No gateway Anthropic HTTP.
 */
export async function probeRateLimitViaOfficialHop({
  homeDir,
  accessToken,
  refreshToken,
  expiresAt,
  timeoutMs = HOP_PROBE_TIMEOUT_MS,
} = {}) {
  if (!homeDir || !accessToken) {
    return { ok: false, source: 'claude_cli_hop', error: 'missing_home_or_access', rate_limits: [] }
  }
  const { streamClaudeCli } = await import('./cli-runner.mjs')
  const acc = { rate_limits: [] }
  const result = await streamClaudeCli({
    model: 'claude-haiku-4-5-20251001',
    body: {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
    },
    accessToken,
    refreshToken,
    expiresAt,
    homeDir,
    timeoutMs,
    onEvent: () => {},
    onRateLimit: (info) => {
      if (info) {
        acc.rate_limits.push(info)
        acc.rate_limit = info
      }
    },
  })
  const rateLimits = result.rate_limits?.length ? result.rate_limits : acc.rate_limits
  return {
    ok: !!result.ok,
    source: 'claude_cli_hop',
    via: result.via || 'cli-stream',
    rate_limits: rateLimits,
    rate_limit: result.rate_limit || acc.rate_limit || null,
    usage: result.usage || null,
    status: result.status,
    error: result.ok ? null : (result.body?.error?.message || result.body?.error || null),
  }
}

export async function probeVmFromOfficialCli({
  homeDir,
  accessToken = null,
  refreshToken = null,
  expiresAt = null,
  hop = false,
  hopReason = null,
  timeoutMs,
} = {}) {
  const auth = await runClaudeAuthStatus({ homeDir, timeoutMs: timeoutMs || AUTH_STATUS_TIMEOUT_MS })
  const harvested = readCliOauth(homeDir)
  let hopResult = null
  if (hop) {
    hopResult = await probeRateLimitViaOfficialHop({
      homeDir,
      accessToken: accessToken || harvested?.access_token,
      refreshToken: refreshToken || harvested?.refresh_token,
      expiresAt: expiresAt || harvested?.expires_at,
      timeoutMs: timeoutMs || HOP_PROBE_TIMEOUT_MS,
    })
  }
  const windows = quotaWindowsFromRateLimits(hopResult?.rate_limits || [])
  return {
    ok: !!(auth.ok && auth.loggedIn) && (!hop || hopResult?.ok !== false),
    source: hop ? 'claude_cli_hop' : 'claude_auth_status',
    hop_skipped: hop ? null : (hopReason || 'auth_status_only'),
    auth,
    harvested: harvested
      ? { has_access: !!harvested.access_token, has_refresh: !!harvested.refresh_token, expires_at: harvested.expires_at || null }
      : { has_access: false, has_refresh: false, expires_at: null },
    five_hour: windows.five_hour,
    seven_day: windows.seven_day,
    extra_usage: hopResult?.rate_limit?.overageStatus
      ? { overage_status: hopResult.rate_limit.overageStatus, is_using_overage: !!hopResult.rate_limit.isUsingOverage }
      : null,
    usage: hopResult?.usage || null,
    hop: hopResult
      ? { ok: hopResult.ok, source: hopResult.source, status: hopResult.status, error: hopResult.error }
      : null,
    probed_at: new Date().toISOString(),
  }
}
