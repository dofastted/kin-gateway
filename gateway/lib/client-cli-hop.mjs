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
import { consumeCliNdjson } from './cli-probe.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(__dirname, 'mcp-bridge.mjs')

// Defense-in-depth denylist. The real guard is permission-mode=default (T5):
// in non-interactive `-p`, any tool that is not pre-approved fails closed.
const BUILTIN_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'Bash', 'BashOutput', 'KillBash', 'KillShell',
  'Grep', 'Glob', 'LS',
  'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'ToolSearch', 'SlashCommand', 'ExitPlanMode',
  'TodoWrite', 'ListMcpResources', 'ReadMcpResource',
]
const BUILTIN_BLOCK = BUILTIN_TOOLS.join(',')
const MAX_SYSTEM_CHARS = 24000

// Request params we cannot faithfully forward through `claude -p`.
// Tracked so the gateway can report them honestly instead of silently dropping.
const UNMAPPABLE_PARAMS = ['max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'stop', 'tool_choice']

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }) }

/**
 * Build CLI args for the client-workspace hop.
 * T5: fail-closed permissions — deny every built-in, only allow the non-executing
 *     MCP stub tools, and use permission-mode=default (no bypass) so unknown/new
 *     built-ins are refused in non-interactive mode.
 * T8: record system-prompt truncation instead of a silent slice.
 * T4: forward what `claude -p` supports (model, thinking via env); record the rest.
 */
export function buildHopArgs({ mdl, mcpCfg, tools, body, resumeSessionId, includePartial = false }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (includePartial) args.push('--include-partial-messages')
  args.push('--model', mdl, '--mcp-config', mcpCfg)

  args.push('--disallowedTools', BUILTIN_BLOCK)
  const allow = tools.map((t) => `mcp__kinclient__${t.name || t.function?.name}`).filter(Boolean)
  if (allow.length) args.push('--allowedTools', allow.join(','))
  args.push('--permission-mode', 'default')

  const sysMeta = { truncated: false }
  const sys = systemToPrompt(body?.system)
  if (sys) {
    sysMeta.orig_len = sys.length
    let kept = sys
    if (sys.length > MAX_SYSTEM_CHARS) {
      kept = sys.slice(0, MAX_SYSTEM_CHARS)
      sysMeta.truncated = true
      sysMeta.kept_len = kept.length
    }
    args.push('--append-system-prompt', kept)
  }

  const paramMeta = { dropped: [], thinking_budget: null }
  for (const k of UNMAPPABLE_PARAMS) {
    if (body?.[k] !== undefined && body?.[k] !== null) paramMeta.dropped.push(k)
  }
  const think = body?.thinking
  if (think && (think.type === 'enabled' || think.budget_tokens)) {
    const n = Number(think.budget_tokens) || 0
    if (n > 0) paramMeta.thinking_budget = n
  }

  if (resumeSessionId) args.push('--resume', String(resumeSessionId))
  return { args, sysMeta, paramMeta }
}

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

function safeParseArgs(v) {
  if (v == null) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(String(v)) } catch { return { _raw: String(v) } }
}

/** Convert an OpenAI data:/http image URL into an Anthropic image block. */
export function openAiImageToAnthropic(url) {
  if (!url) return null
  const m = String(url).match(/^data:([^;]+);base64,(.+)$/)
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
  if (/^https?:\/\//.test(String(url))) return { type: 'image', source: { type: 'url', url: String(url) } }
  return null
}

/**
 * Normalize a message's `content` into Anthropic content blocks, preserving
 * text / images / tool_use / tool_result / documents across OpenAI + Anthropic shapes.
 */
export function toAnthropicBlocks(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) {
    if (content.type) return [content]
    if (content.text) return [{ type: 'text', text: content.text }]
    return []
  }
  const out = []
  for (const b of content) {
    if (b == null) continue
    if (typeof b === 'string') { if (b) out.push({ type: 'text', text: b }); continue }
    const t = b.type
    if (t === 'text' || t === 'input_text' || t === 'output_text') {
      if (b.text) out.push({ type: 'text', text: b.text })
      continue
    }
    if (t === 'image' || t === 'input_image') {
      if (b.source) { out.push({ type: 'image', source: b.source }); continue }
      const url = typeof b.image_url === 'string' ? b.image_url : (b.image_url?.url || b.url)
      const conv = openAiImageToAnthropic(url)
      if (conv) out.push(conv)
      continue
    }
    if (t === 'image_url') {
      const url = typeof b.image_url === 'string' ? b.image_url : b.image_url?.url
      const conv = openAiImageToAnthropic(url)
      if (conv) out.push(conv)
      continue
    }
    if (t === 'tool_use') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} })
      continue
    }
    if (t === 'tool_result') {
      out.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: typeof b.content === 'string' || Array.isArray(b.content)
          ? b.content
          : JSON.stringify(b.content || ''),
      })
      continue
    }
    if (t === 'document') { out.push(b); continue }
    if (b.text) { out.push({ type: 'text', text: b.text }); continue }
  }
  return out
}

function blockToTranscriptSeg(b) {
  if (!b) return ''
  if (b.type === 'text') return b.text || ''
  if (b.type === 'image') return '[image]'
  if (b.type === 'document') return '[document]'
  if (b.type === 'tool_use') return `[tool_use ${b.name}(${JSON.stringify(b.input || {})})]`
  if (b.type === 'tool_result') {
    const c = typeof b.content === 'string' ? b.content
      : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').filter(Boolean).join('\n')
        : JSON.stringify(b.content || '')
    return `[tool_result ${b.tool_use_id || ''}: ${c}]`
  }
  return ''
}

function messageToBlocks(m) {
  const blocks = toAnthropicBlocks(m?.content)
  // OpenAI assistant tool_calls → native tool_use blocks
  if (Array.isArray(m?.tool_calls)) {
    for (const tc of m.tool_calls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || tc.name, input: safeParseArgs(tc.function?.arguments ?? tc.arguments) })
    }
  }
  // OpenAI tool role → tool_result block
  if (m?.role === 'tool') {
    blocks.unshift({ type: 'tool_result', tool_use_id: m.tool_call_id || m.id, content: textOf(m.content) })
  }
  return blocks
}

function renderHistoryTranscript(history) {
  const parts = []
  for (const m of history) {
    const role = m?.role
    if (role === 'system' || role === 'developer') continue
    const label = role === 'assistant' ? 'Assistant' : role === 'tool' ? 'Tool' : 'Human'
    const segs = messageToBlocks(m).map(blockToTranscriptSeg).filter(Boolean)
    if (segs.length) parts.push(`${label}: ${segs.join('\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * Build stream-json input turn line(s) for the client-workspace hop.
 *
 * - resumeSessionId present: send only the trailing user/tool turn natively;
 *   the CLI already holds prior history via --resume.
 * - no resume: preserve full multi-turn CONTEXT. Prior turns are rendered into a
 *   transcript text block; the trailing turn's native blocks (text/images/tool_result)
 *   are attached so images and tool results survive.
 *
 * Returns { lines: string[], meta: { turns, had_images, had_tool_results, history_flattened } }
 */
export function buildStreamJsonTurns(messages = [], { resumeSessionId = null } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system' && m.role !== 'developer')
  const meta = { turns: 0, had_images: false, had_tool_results: false, history_flattened: false }

  const userLine = (blocks) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })

  const markMedia = (blocks) => {
    for (const b of blocks) {
      if (b?.type === 'image') meta.had_images = true
      if (b?.type === 'tool_result') meta.had_tool_results = true
    }
  }

  // Trailing input = last user/tool message; everything before is history.
  let splitIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user' || list[i].role === 'tool') { splitIdx = i; break }
  }

  // Resume: only the trailing turn is needed.
  if (resumeSessionId) {
    const trailing = splitIdx >= 0 ? list.slice(splitIdx) : []
    const blocks = []
    for (const m of trailing) blocks.push(...messageToBlocks(m))
    if (!blocks.length) blocks.push({ type: 'text', text: 'Hello' })
    markMedia(blocks)
    meta.turns = 1
    return { lines: [userLine(blocks)], meta }
  }

  const trailingMsgs = splitIdx >= 0 ? list.slice(splitIdx) : []
  const history = splitIdx >= 0 ? list.slice(0, splitIdx) : list

  const trailingBlocks = []
  for (const m of trailingMsgs) trailingBlocks.push(...messageToBlocks(m))

  // Single effective turn (common case): send its native blocks directly.
  if (history.length === 0) {
    const blocks = trailingBlocks.length ? trailingBlocks : [{ type: 'text', text: 'Hello' }]
    markMedia(blocks)
    meta.turns = 1
    return { lines: [userLine(blocks)], meta }
  }

  // Multi-turn: flatten prior context to text, keep trailing native blocks.
  meta.history_flattened = true
  const transcript = renderHistoryTranscript(history)
  const blocks = []
  if (transcript) blocks.push({ type: 'text', text: `Conversation so far:\n${transcript}` })
  if (trailingBlocks.length) blocks.push(...trailingBlocks)
  if (!blocks.length) blocks.push({ type: 'text', text: 'Hello' })
  markMedia(blocks)
  meta.turns = 1
  return { lines: [userLine(blocks)], meta }
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
  onRateLimit,
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
  const { args, sysMeta, paramMeta } = buildHopArgs({ mdl, mcpCfg, tools, body, resumeSessionId, includePartial: false })

  const env = {
    ...process.env,
    HOME: workHome,
    CLAUDE_HOME: workHome,
    CLAUDE_CONFIG_DIR: path.join(workHome, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DO_NOT_TRACK: '1',
  }
  if (paramMeta.thinking_budget) env.MAX_THINKING_TOKENS = String(paramMeta.thinking_budget)
  if (proxyUrl) {
    // SOCKS hangs the claude binary historically — leave unset unless explicitly enabled
  }

  const { lines: stdinLines, meta: turnMeta } = buildStreamJsonTurns(body?.messages || [], { resumeSessionId })

  const acc = {
    session_id: resumeSessionId || null,
    tool_uses: [],
    text: '',
    usage: null,
    rate_limit: null,
    rate_limits: [],
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
      consumeCliNdjson(line, acc)
      if (obj.type === 'rate_limit_event' && typeof onRateLimit === 'function' && acc.rate_limit) {
        try { onRateLimit(acc.rate_limit, obj) } catch {}
      }
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

  const hopMeta = { ...turnMeta, system: sysMeta, params: paramMeta }

  if (acc.tool_uses.length) {
    return {
      status: 200,
      ok: true,
      via: 'cli-client-workspace',
      session_id: acc.session_id,
      usage: acc.usage,
      rate_limit: acc.rate_limit,
      rate_limits: acc.rate_limits,
      hop_meta: hopMeta,
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
    rate_limit: acc.rate_limit,
    rate_limits: acc.rate_limits,
    hop_meta: hopMeta,
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
  const { args, sysMeta, paramMeta } = buildHopArgs({ mdl, mcpCfg, tools, body, resumeSessionId, includePartial: true })

  const env = {
    ...process.env,
    HOME: workHome,
    CLAUDE_HOME: workHome,
    CLAUDE_CONFIG_DIR: path.join(workHome, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DO_NOT_TRACK: '1',
  }
  if (paramMeta.thinking_budget) env.MAX_THINKING_TOKENS = String(paramMeta.thinking_budget)

  const { lines: stdinLines, meta: turnMeta } = buildStreamJsonTurns(body?.messages || [], { resumeSessionId })

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
      consumeCliNdjson(line, acc)
      if (obj.type === 'rate_limit_event' && typeof onRateLimit === 'function' && acc.rate_limit) {
        try { onRateLimit(acc.rate_limit, obj) } catch {}
      }
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
    hop_meta: { ...turnMeta, system: sysMeta, params: paramMeta },
  }
}


function spawnCli({ args, env, cwd, timeoutMs, stdin, onLine, shouldStop }) {
  return new Promise((resolve) => {
    // detached:true → new process group (setsid), so we can signal the whole
    // sudo→claude subtree and avoid orphaned CLI processes on early stop (T6).
    const child = spawn('sudo', ['-u', 'kincli', '-E', 'claude', ...args], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let buf = ''
    let killed = false
    let done = false

    // Kill the whole process group; fall back to the direct child pid.
    const killTree = (sig) => {
      try { process.kill(-child.pid, sig) }
      catch { try { child.kill(sig) } catch {} }
    }
    const hardKill = () => {
      killTree('SIGTERM')
      setTimeout(() => { if (!done) killTree('SIGKILL') }, 500)
    }

    const timer = setTimeout(() => { killed = true; hardKill() }, timeoutMs)

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
        hardKill()
      }
    }

    child.stdout.on('data', (c) => feed(String(c)))
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('close', (code) => {
      done = true
      clearTimeout(timer)
      if (buf.trim()) {
        try { onLine(buf.trim()) } catch {}
      }
      resolve({ code: code ?? 1, stdout, stderr, killed })
    })
    child.on('error', (err) => {
      done = true
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: String(err.message || err), killed })
    })
    try {
      child.stdin.write(stdin)
      child.stdin.end()
    } catch {}
  })
}
