/**
 * Forward inference ONLY through VM-local Claude Code CLI.
 * True streaming via: claude -p --output-format stream-json --verbose --include-partial-messages
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function buildProxyEnv(proxyUrl) {
  if (!proxyUrl) return {}
  return {
    ALL_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
  }
}


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

export function messagesToPrompt(body) {
  const parts = []
  const sys = body?.system
  if (typeof sys === 'string' && sys.trim()) parts.push(sys.trim())
  else if (Array.isArray(sys)) {
    const t = sys.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n')
    if (t) parts.push(t)
  }
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  for (const m of msgs) {
    let text = ''
    if (typeof m.content === 'string') text = m.content
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : ''))
        .filter(Boolean)
        .join('\n')
    }
    if (!text) continue
    const role = m.role || 'user'
    if (role === 'system') parts.push(text)
    else if (role === 'assistant') parts.push(`Assistant: ${text}`)
    else parts.push(text)
  }
  return parts.join('\n\n').trim() || 'Hello'
}

/**
 * Seed a pure CLI home for this VM.
 * NEVER copy host/user ~/.claude or settings.json — VM settings are the sole source.
 */
function writeCliHome({ homeDir, accessToken, refreshToken, expiresAt, timezone, locale, kernel, seedPolicy }) {
  ensureDir(homeDir)
  const claudeDir = path.join(homeDir, '.claude')
  ensureDir(claudeDir)
  const exp = Number(expiresAt) || 0
  const expMs = exp && exp < 10_000_000_000 ? exp * 1000 : exp
  const creds = {
    claudeAiOauth: {
      accessToken,
      refreshToken: refreshToken || null,
      expiresAt: expMs || Date.now() + 8 * 3600 * 1000,
      scopes: ['user:inference', 'user:sessions:claude_code', 'user:profile'],
    },
  }
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 })
  fs.writeFileSync(path.join(claudeDir, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(path.join(claudeDir, '.credentials.json'), 0o600)
  } catch {}

  const pol = seedPolicy || {}
  const env = { ...(pol.extra_env || {}) }
  if (pol.telemetry_disabled !== false) env.DISABLE_TELEMETRY = '1'
  if (pol.disable_nonessential_traffic !== false) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  if (pol.do_not_track !== false) env.DO_NOT_TRACK = '1'
  let settings
  if (pol.settings_json_override && typeof pol.settings_json_override === 'object') {
    settings = { ...pol.settings_json_override }
    settings.env = { ...(settings.env || {}), ...env }
  } else {
    settings = { env, theme: pol.theme || 'dark' }
  }
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2))
  // Minimal .claude.json without host machine identity
  const minimal = {
    firstStartTime: new Date().toISOString(),
    migrationVersion: 13,
    hasCompletedOnboarding: true,
    // no machineID / userID / oauthAccount — credentials file is the auth source
  }
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify(minimal, null, 2))
  // marker for ops
  fs.writeFileSync(
    path.join(claudeDir, 'kin-seed.json'),
    JSON.stringify({
      pure: true,
      kernel: kernel || null,
      timezone: timezone || 'UTC',
      locale: locale || 'en_US.UTF-8',
      telemetry: 'disabled',
      seeded_at: new Date().toISOString(),
    }, null, 2),
  )
  try {
    spawn('chown', ['-R', 'kincli:kincli', homeDir], { stdio: 'ignore' })
  } catch {}
}

function toAnthropicMessage({ text, model, usage }) {
  return {
    id: `msg_cli_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: model || 'claude',
    content: [{ type: 'text', text: text || '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: usage || { input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * Minimal env — do NOT spread host process.env (leaks TZ, user settings, telemetry).
 * VM timezone/locale are the only locale source.
 */
function buildEnv({ workHome, accessToken, proxyUrl, timezone, locale, seedPolicy }) {
  const env = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: workHome,
    USER: 'kincli',
    LOGNAME: 'kincli',
    SHELL: '/bin/bash',
    CLAUDE_CONFIG_DIR: path.join(workHome, '.claude'),
    ANTHROPIC_AUTH_TOKEN: accessToken,
    CLAUDE_CODE_OAUTH_TOKEN: accessToken,
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    TZ: timezone || 'UTC',
    LANG: locale || 'en_US.UTF-8',
    LC_ALL: locale || 'en_US.UTF-8',
    ...buildProxyEnv(proxyUrl),
  }
  const pol = seedPolicy || {}
  if (pol.telemetry_disabled !== false) env.DISABLE_TELEMETRY = '1'
  if (pol.disable_nonessential_traffic !== false) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  if (pol.do_not_track !== false) env.DO_NOT_TRACK = '1'
  if (pol.extra_env && typeof pol.extra_env === 'object') {
    for (const [k, v] of Object.entries(pol.extra_env)) {
      if (v == null) delete env[k]
      else env[k] = String(v)
    }
  }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_BASE_URL
  delete env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
  return env
}

function spawnClaude({ args, env, cwd, timeoutMs, onStdoutLine }) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-u', 'kincli', '-E', '--', 'claude', ...args], {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let buf = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch {}
      try {
        spawn('pkill', ['-9', '-u', 'kincli', '-f', 'claude -p'], { stdio: 'ignore' })
      } catch {}
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      const s = d.toString('utf8')
      stdout += s
      if (typeof onStdoutLine === 'function') {
        buf += s
        const parts = buf.split('\n')
        buf = parts.pop() || ''
        for (const line of parts) {
          const trimmed = line.replace(/\r$/, '')
          if (trimmed) onStdoutLine(trimmed)
        }
      }
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buf.trim() && typeof onStdoutLine === 'function') {
        try {
          onStdoutLine(buf.trim())
        } catch {}
      }
      resolve({ code: code ?? 1, stdout, stderr, killed })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: String(err.message || err), killed })
    })
  })
}

/** Non-stream: text output */
export async function callClaudeCli({
  model,
  body,
  accessToken,
  refreshToken,
  expiresAt,
  proxyUrl,
  homeDir,
  timezone,
  locale,
  kernel,
  seedPolicy,
  timeoutMs = 120000,
}) {
  if (!accessToken) {
    return {
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
      headers: {},
      via: 'cli',
    }
  }
  const workHome = homeDir || path.join(os.tmpdir(), 'kin-cli-home')
  writeCliHome({ homeDir: workHome, accessToken, refreshToken, expiresAt, timezone, locale, kernel, seedPolicy })
  const prompt = messagesToPrompt(body)
  const mdl = model || body?.model || 'claude-haiku-4-5-20251001'
  const args = ['-p', prompt, '--model', mdl, '--output-format', 'text']
  const env = buildEnv({ workHome, accessToken, proxyUrl, timezone, locale, seedPolicy })
  const result = await spawnClaude({ args, env, cwd: workHome, timeoutMs })
  if (result.killed) {
    return {
      status: 504,
      body: { type: 'error', error: { type: 'timeout_error', message: `claude cli timeout after ${timeoutMs}ms` } },
      headers: {},
      via: 'cli',
    }
  }
  if (result.code !== 0) {
    const errText = (result.stderr || result.stdout || '').slice(0, 2000)
    const isRate = /rate.?limit|429|usage.?limit|exceeded/i.test(errText)
    const isAuth = /auth|unauthorized|401|oauth|login/i.test(errText)
    return {
      status: isRate ? 429 : isAuth ? 401 : 502,
      body: {
        type: 'error',
        error: {
          type: isRate ? 'rate_limit_error' : isAuth ? 'authentication_error' : 'api_error',
          message: errText.trim() || `claude cli exited ${result.code}`,
        },
      },
      headers: {},
      via: 'cli',
    }
  }
  const text = String(result.stdout || '').trim()
  return {
    status: 200,
    body: toAnthropicMessage({ text, model: mdl }),
    headers: {},
    via: 'cli',
  }
}

/**
 * True streaming:
 * - CLI emits NDJSON stream-json lines
 * - stream_event.event is native Anthropic SSE payload
 * - We forward as `data: {...}` lines for existing converters
 */
export async function streamClaudeCli({
  model,
  body,
  accessToken,
  refreshToken,
  expiresAt,
  proxyUrl,
  homeDir,
  timeoutMs = 180000,
  onEvent,
  onHeaders,
  includeThinking = true,
}) {
  if (!accessToken) {
    return {
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
      headers: {},
      ok: false,
      via: 'cli',
    }
  }

  const workHome = homeDir || path.join(os.tmpdir(), 'kin-cli-home')
  writeCliHome({ homeDir: workHome, accessToken, refreshToken, expiresAt, timezone, locale, kernel, seedPolicy })
  const prompt = messagesToPrompt(body)
  const mdl = model || body?.model || 'claude-haiku-4-5-20251001'
  const args = [
    '-p',
    prompt,
    '--model',
    mdl,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]
  const env = buildEnv({ workHome, accessToken, proxyUrl, timezone, locale, seedPolicy })

  if (typeof onHeaders === 'function') {
    try {
      onHeaders({ 'content-type': 'text/event-stream', 'x-kin-via': 'claude-cli-stream' })
    } catch {}
  }

  let sawText = false
  let resultText = ''
  let errorBody = null
  let indexMap = new Map() // original index -> emitted text index
  let nextTextIndex = 0
  let thinkingIndexes = new Set()

  const result = await spawnClaude({
    args,
    env,
    cwd: workHome,
    timeoutMs,
    onStdoutLine: (line) => {
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        return
      }
      const t = obj.type

      if (t === 'result') {
        if (typeof obj.result === 'string') resultText = obj.result
        return
      }

      if (t === 'stream_event' && obj.event) {
        const ev = obj.event
        // Transparent: forward ALL events including thinking / signature as-is
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          sawText = true
        }
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
          sawText = true
        }
        if (typeof onEvent === 'function') {
          Promise.resolve(onEvent(`data: ${JSON.stringify(ev)}`)).catch(() => {})
        }
        return
      }

      // fatal-ish system errors sometimes appear as objects
      if (t === 'error' || obj.error) {
        errorBody = obj.error || obj
      }
    },
  })

  if (result.killed) {
    return {
      status: 504,
      body: { type: 'error', error: { type: 'timeout_error', message: `claude cli stream timeout after ${timeoutMs}ms` } },
      headers: {},
      ok: false,
      via: 'cli-stream',
    }
  }

  if (result.code !== 0 && !sawText && !resultText) {
    const errText = (result.stderr || result.stdout || '').slice(0, 2000)
    const isRate = /rate.?limit|429|usage.?limit|exceeded/i.test(errText)
    return {
      status: isRate ? 429 : 502,
      body: {
        type: 'error',
        error: {
          type: isRate ? 'rate_limit_error' : 'api_error',
          message: errText.trim() || `claude cli stream exited ${result.code}`,
        },
      },
      headers: {},
      ok: false,
      via: 'cli-stream',
    }
  }

  return {
    status: 200,
    ok: true,
    headers: { 'x-kin-via': 'claude-cli-stream' },
    via: 'cli-stream',
    resultText,
  }
}
