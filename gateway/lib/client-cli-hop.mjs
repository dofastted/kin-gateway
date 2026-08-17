/**
 * Client-workspace hop via official Claude Code CLI.
 *
 * Built-in VM file/shell tools are disabled.
 * Client tools are exposed as an MCP stub that never executes.
 * First tool_use is returned to the HTTP client (Windows/local Claude).
 * Supports non-stream (callClientWorkspaceCli) and stream (streamClientWorkspaceCli).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeCliHome } from './cli-runner.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(__dirname, 'mcp-bridge.mjs')
const BUILTIN_BLOCK = 'Read,Write,Edit,Bash,Grep,Glob,WebFetch,WebSearch,Agent,Skill,NotebookEdit,Task,ToolSearch'

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }) }

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content?.text || ''
  return content.map((b) => {
    if (typeof b === 'string') return b
    if (b?.type === 'text') return b.text || ''
    return ''
  }).filter(Boolean).join('\n')
}

export function systemToPrompt(system) {
  if (!system) return ''
  if (typeof system === 'string') return system.trim()
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n').trim()
  }
  return ''
}

export function extractLatestToolResults(messages = []) {
  const out = []
  for (const m of messages) {
    if (m?.role === 'tool') {
      out.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.id,
        content: textOf(m.content),
      })
      continue
    }
    if (!Array.isArray(m?.content)) continue
    for (const b of m.content) {
      if (b?.type === 'tool_result') {
        out.push({
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''),
        })
      }
    }
  }
  return out
}

export function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const t = textOf(m.content)
    if (t && !String(t).includes('tool_result')) return t
    if (Array.isArray(m.content) && m.content.every((b) => b?.type === 'tool_result')) continue
    if (t) return t
  }
  return ''
}

function normalizeToolName(name = '') {
  const s = String(name)
  const m = s.match(/^mcp__[^_]+__(.+)$/)
  return m ? m[1] : s
}

function parseStreamLine(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('{')) return null
  try { return JSON.parse(raw) } catch { return null }
}

function collectToolUses(obj) {
  const found = []
  if (!obj || typeof obj !== 'object') return found
  if (obj.type === 'assistant' && obj.message?.content) {
    for (const b of obj.message.content) {
      if (b?.type === 'tool_use' && b.name) found.push(b)
    }
  }
  if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
    found.push(obj.content_block)
  }
  return found
}

export async function callClientWorkspaceCli({
  accessToken,
  refreshToken,
  expiresAt,
  homeDir,
  timezone,
  locale,
  kernel,
  seedPolicy,
  proxyUrl,
  body,
  resumeSessionId = null,
  timeoutMs = 180000,
}) {
  if (!accessToken) {
    return {
      status: 401,
      ok: false,
      via: 'cli-client-workspace',
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
    }
  }

  const workHome = homeDir || path.join(os.tmpdir(), 'kin-cli-home')
  writeCliHome({ homeDir: workHome, accessToken, refreshToken, expiresAt, timezone, locale, kernel, seedPolicy })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcp-'))
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const toolsFile = path.join(tmp, 'tools.json')
  const callFile = path.join(tmp, 'call.json')
  const mcpCfg = path.join(tmp, 'mcp.json')
  fs.writeFileSync(toolsFile, JSON.stringify(tools))
  fs.writeFileSync(mcpCfg, JSON.stringify({
    mcpServers: {
      kinclient: {
        command: process.execPath,
        args: [BRIDGE],
        env: {
          KIN_MCP_TOOLS_FILE: toolsFile,
          KIN_MCP_CALL_FILE: callFile,
        },
      },
    },
  }))
  try {
    fs.chmodSync(tmp, 0o777)
    fs.chmodSync(toolsFile, 0o666)
    fs.chmodSync(mcpCfg, 0o666)
    fs.chmodSync(BRIDGE, 0o755)
  } catch {}

  const mdl = body?.model || 'claude-haiku-4-5-20251001'
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', mdl,
    '--mcp-config', mcpCfg,
    '--disallowedTools', BUILTIN_BLOCK,
    '--permission-mode', 'bypassPermissions',
  ]
  if (tools.length) {
    args.push('--allowedTools', tools.map((t) => `mcp__kinclient__${t.name || t.function?.name}`).filter(Boolean).join(','))
  }
  const sys = systemToPrompt(body?.system)
  if (sys) args.push('--append-system-prompt', sys.slice(0, 12000))
  if (resumeSessionId) args.push('--resume', String(resumeSessionId))

  const env = {
    ...process.env,
    HOME: workHome,
    CLAUDE_HOME: workHome,
    CLAUDE_CONFIG_DIR: path.join(workHome, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DO_NOT_TRACK: '1',
  }
  if (proxyUrl) {
    // SOCKS hangs the claude binary historically — leave unset unless explicitly enabled
  }

  const stdinLines = []
  const results = extractLatestToolResults(body?.messages || [])
  if (resumeSessionId && results.length) {
    stdinLines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: results },
    }))
  } else {
    const userText = lastUserText(body?.messages || []) || 'Hello'
    const content = []
    if (results.length) content.push(...results)
    if (userText) content.push({ type: 'text', text: userText })
    stdinLines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: content.length === 1 && content[0].type === 'text' ? userText : content },
    }))
  }

  const acc = {
    session_id: resumeSessionId || null,
    tool_uses: [],
    text: '',
    usage: null,
  }

  const result = await spawnCli({
    args,
    env,
    cwd: workHome,
    timeoutMs,
    stdin: stdinLines.join('\n') + '\n',
    onLine: (line) => {
      const obj = parseStreamLine(line)
      if (!obj) return
      if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) acc.session_id = obj.session_id
      if (obj.session_id && !acc.session_id) acc.session_id = obj.session_id
      for (const tu of collectToolUses(obj)) {
        acc.tool_uses.push({
          type: 'tool_use',
          id: tu.id || `toolu_${Date.now().toString(36)}`,
          name: normalizeToolName(tu.name),
          input: tu.input || {},
        })
      }
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (b?.type === 'text' && b.text) acc.text += b.text
        }
      }
      if (obj.type === 'result') {
        if (obj.result && !acc.text) acc.text = String(obj.result)
        acc.usage = obj.usage || acc.usage
      }
    },
    shouldStop: () => acc.tool_uses.length > 0 || fs.existsSync(callFile),
  })

  let mcpCall = null
  try {
    if (fs.existsSync(callFile)) mcpCall = JSON.parse(fs.readFileSync(callFile, 'utf8'))
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

  if (mcpCall?.name && !acc.tool_uses.some((t) => t.name === normalizeToolName(mcpCall.name))) {
    acc.tool_uses.push({
      type: 'tool_use',
      id: `toolu_${Date.now().toString(36)}`,
      name: normalizeToolName(mcpCall.name),
      input: mcpCall.arguments || {},
    })
  }

  if (acc.tool_uses.length) {
    return {
      status: 200,
      ok: true,
      via: 'cli-client-workspace',
      session_id: acc.session_id,
      usage: acc.usage,
      body: {
        id: `msg_${acc.session_id || Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: mdl,
        content: acc.tool_uses,
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: acc.usage || { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  if (result.killed && !acc.text) {
    return {
      status: 504,
      ok: false,
      via: 'cli-client-workspace',
      session_id: acc.session_id,
      body: { type: 'error', error: { type: 'timeout_error', message: `client-workspace hop timeout after ${timeoutMs}ms` } },
    }
  }

  return {
    status: 200,
    ok: true,
    via: 'cli-client-workspace',
    session_id: acc.session_id,
    usage: acc.usage,
    body: {
      id: `msg_${acc.session_id || Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: mdl,
      content: [{ type: 'text', text: acc.text || '' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: acc.usage || { input_tokens: 0, output_tokens: 0 },
    },
  }
}

/**
 * Streaming client-workspace hop.
 * Forwards native Anthropic stream_event payloads as `data: {...}` lines.
 * Stops early on first tool_use so the caller can execute tools locally.
 */
export async function streamClientWorkspaceCli({
  accessToken,
  refreshToken,
  expiresAt,
  homeDir,
  timezone,
  locale,
  kernel,
  seedPolicy,
  proxyUrl,
  body,
  resumeSessionId = null,
  timeoutMs = 180000,
  onEvent,
  onHeaders,
  onRateLimit,
}) {
  if (!accessToken) {
    return {
      status: 401,
      ok: false,
      via: 'cli-client-workspace-stream',
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
    }
  }

  const workHome = homeDir || path.join(os.tmpdir(), 'kin-cli-home')
  writeCliHome({ homeDir: workHome, accessToken, refreshToken, expiresAt, timezone, locale, kernel, seedPolicy })

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mcp-'))
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const toolsFile = path.join(tmp, 'tools.json')
  const callFile = path.join(tmp, 'call.json')
  const mcpCfg = path.join(tmp, 'mcp.json')
  fs.writeFileSync(toolsFile, JSON.stringify(tools))
  fs.writeFileSync(mcpCfg, JSON.stringify({
    mcpServers: {
      kinclient: {
        command: process.execPath,
        args: [BRIDGE],
        env: {
          KIN_MCP_TOOLS_FILE: toolsFile,
          KIN_MCP_CALL_FILE: callFile,
        },
      },
    },
  }))
  try {
    fs.chmodSync(tmp, 0o777)
    fs.chmodSync(toolsFile, 0o666)
    fs.chmodSync(mcpCfg, 0o666)
    fs.chmodSync(BRIDGE, 0o755)
  } catch {}

  const mdl = body?.model || 'claude-haiku-4-5-20251001'
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', mdl,
    '--mcp-config', mcpCfg,
    '--disallowedTools', BUILTIN_BLOCK,
    '--permission-mode', 'bypassPermissions',
  ]
  if (tools.length) {
    args.push('--allowedTools', tools.map((t) => `mcp__kinclient__${t.name || t.function?.name}`).filter(Boolean).join(','))
  }
  const sys = systemToPrompt(body?.system)
  if (sys) args.push('--append-system-prompt', sys.slice(0, 12000))
  if (resumeSessionId) args.push('--resume', String(resumeSessionId))

  const env = {
    ...process.env,
    HOME: workHome,
    CLAUDE_HOME: workHome,
    CLAUDE_CONFIG_DIR: path.join(workHome, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DO_NOT_TRACK: '1',
  }

  const stdinLines = []
  const results = extractLatestToolResults(body?.messages || [])
  if (resumeSessionId && results.length) {
    stdinLines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: results },
    }))
  } else {
    const userText = lastUserText(body?.messages || []) || 'Hello'
    const content = []
    if (results.length) content.push(...results)
    if (userText) content.push({ type: 'text', text: userText })
    stdinLines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: content.length === 1 && content[0].type === 'text' ? userText : content },
    }))
  }

  if (typeof onHeaders === 'function') {
    try {
      onHeaders({ 'content-type': 'text/event-stream', 'x-kin-via': 'cli-client-workspace-stream' })
    } catch {}
  }

  const acc = {
    session_id: resumeSessionId || null,
    tool_uses: [],
    text: '',
    usage: null,
    rate_limit: null,
    rate_limits: [],
    saw_stream: false,
  }

  const emit = (evt) => {
    if (typeof onEvent !== 'function') return
    Promise.resolve(onEvent(`data: ${JSON.stringify(evt)}`)).catch(() => {})
  }

  const result = await spawnCli({
    args,
    env,
    cwd: workHome,
    timeoutMs,
    stdin: stdinLines.join('\n') + '\n',
    onLine: (line) => {
      let obj
      try { obj = JSON.parse(line) } catch { return }
      if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) acc.session_id = obj.session_id
      if (obj.session_id && !acc.session_id) acc.session_id = obj.session_id

      if (obj.type === 'stream_event' && obj.event) {
        acc.saw_stream = true
        const ev = obj.event
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          const name = normalizeToolName(ev.content_block.name || '')
          acc.tool_uses.push({
            type: 'tool_use',
            id: ev.content_block.id,
            name,
            input: ev.content_block.input || {},
          })
          emit({
            ...ev,
            content_block: { ...ev.content_block, name },
          })
          return
        }
        emit(ev)
        return
      }

      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (b?.type === 'tool_use') {
            const name = normalizeToolName(b.name || '')
            if (!acc.tool_uses.some((t) => t.id === b.id)) {
              acc.tool_uses.push({ type: 'tool_use', id: b.id, name, input: b.input || {} })
            }
          }
          if (b?.type === 'text' && b.text) acc.text += b.text
        }
      }
      if (obj.type === 'result') {
        if (typeof obj.result === 'string') acc.text = obj.result
        if (obj.usage) acc.usage = obj.usage
      }
    },
    shouldStop: () => acc.tool_uses.length > 0 || fs.existsSync(callFile),
  })

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

  // If tool_use arrived without stream_event framing, synthesize minimal SSE.
  if (acc.tool_uses.length && !acc.saw_stream) {
    const msgId = `msg_${acc.session_id || Date.now()}`
    emit({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: mdl, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })
    acc.tool_uses.forEach((tu, i) => {
      emit({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} } })
      emit({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input || {}) } })
      emit({ type: 'content_block_stop', index: i })
    })
    emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: acc.usage || { output_tokens: 0 } })
    emit({ type: 'message_stop' })
  }

  if (result.killed && !acc.tool_uses.length && !acc.text && !acc.saw_stream) {
    return {
      status: 504,
      ok: false,
      via: 'cli-client-workspace-stream',
      session_id: acc.session_id,
      body: { type: 'error', error: { type: 'timeout_error', message: `client-workspace stream timeout after ${timeoutMs}ms` } },
    }
  }

  return {
    status: 200,
    ok: true,
    via: 'cli-client-workspace-stream',
    session_id: acc.session_id,
    usage: acc.usage,
    rate_limit: acc.rate_limit,
    rate_limits: acc.rate_limits,
    tool_uses: acc.tool_uses,
  }
}


function spawnCli({ args, env, cwd, timeoutMs, stdin, onLine, shouldStop }) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-u', 'kincli', '-E', 'claude', ...args], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let buf = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    const feed = (chunk) => {
      buf += chunk
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) {
        stdout += line + '\n'
        try { onLine(line) } catch {}
      }
      if (shouldStop?.()) {
        killed = true
        try { child.kill('SIGTERM') } catch {}
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 400)
      }
    }

    child.stdout.on('data', (c) => feed(String(c)))
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buf.trim()) {
        try { onLine(buf.trim()) } catch {}
      }
      resolve({ code: code ?? 1, stdout, stderr, killed })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: String(err.message || err), killed })
    })
    try {
      child.stdin.write(stdin)
      child.stdin.end()
    } catch {}
  })
}
