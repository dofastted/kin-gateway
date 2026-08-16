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

function writeCliHome({ homeDir, accessToken, refreshToken, expiresAt }) {
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
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(creds, null, 2))
  fs.writeFileSync(path.join(claudeDir, 'credentials.json'), JSON.stringify(creds, null, 2))
  try {
    fs.chmodSync(path.join(claudeDir, '.credentials.json'), 0o600)
  } catch {}
  // ownership for kincli
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

function buildEnv({ workHome, accessToken, proxyUrl }) {
  const env = {
    ...process.env,
    HOME: workHome,
    USER: 'kincli',
    LOGNAME: 'kincli',
    CLAUDE_CONFIG_DIR: path.join(workHome, '.claude'),
    ANTHROPIC_AUTH_TOKEN: accessToken,
    CLAUDE_CODE_OAUTH_TOKEN: accessToken,
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    ...buildProxyEnv(proxyUrl),
  }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_BASE_URL
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
  writeCliHome({ homeDir: workHome, accessToken, refreshToken, expiresAt })
  const prompt = messagesToPrompt(body)
  const mdl = model || body?.model || 'claude-haiku-4-5-20251001'
  const args = ['-p', prompt, '--model', mdl, '--output-format', 'text']
  const env = buildEnv({ workHome, accessToken, proxyUrl })
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
  writeCliHome({ homeDir: workHome, accessToken, refreshToken, expiresAt })
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
  const env = buildEnv({ workHome, accessToken, proxyUrl })

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
