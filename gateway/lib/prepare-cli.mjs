/**
 * Prepare an inbound (already converted) Messages body for VM-local Claude Code.
 *
 * VM already runs official Claude Code — do not inject billing/identity.
 * Foreign 人设 (Pi / Codex / ChatGPT / Hermes / OpenClaw / unknown) is
 * rewritten into official system text blocks and appended.
 * Tools are kept (official protocol). Unknown top-level keys still dropped via allowlist.
 */

/** Only these top-level keys survive into the CLI hop. Unknown keys are dropped. */
const ALLOWED_TOP = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stop',
  'tools',
  'tool_choice',
])

const OFFICIAL_IDENTITY = [
  /^x-anthropic-billing-header\b/i,
  /^you are a claude agent, built on anthropic's claude agent sdk\.?$/i,
  /^you are claude code, anthropic's official cli for claude/i,
  /^you are claude code, anthropic's official cli for claude, running within the claude agent sdk/i,
  /^you are a file search specialist for claude code/i,
  /^you are a security monitor for autonomous ai coding agents/i,
  /^you are an interactive agent that helps users with software engineering tasks/i,
]

const OFFICIAL_CWD = /^cwd:\s.+\ndate:\s\d{4}-\d{2}-\d{2}\s*$/i

const FOREIGN_IDENTITY = [
  /you are chatgpt/i,
  /you are a coding assistant.*openai/i,
  /openai.*codex/i,
  /codex cli/i,
  /powered by gpt/i,
  /operating inside pi/i,
  /pi-coding-agent/i,
  /pi, a coding agent harness/i,
  /you are an expert coding assistant/i,
  /you are a coding agent/i,
  /guideline.*tool use.*openai/i,
  /you are hermes/i,
  /hermes-agent/i,
  /nous research/i,
  /soul\.md/i,
  /operating inside (open)?claw/i,
  /running inside openclaw/i,
  /you are (a )?personal assistant running inside openclaw/i,
  /openclaw/i,
  /clawdbot/i,
  /moltbot/i,
  /<available_skills>/i,
]

export const CODEX_TOOL_MAP = {
  apply_patch: 'Bash',
  applyPatch: 'Bash',
  execute_bash: 'Bash',
  executeBash: 'Bash',
  exec_bash: 'Bash',
  execBash: 'Bash',
  read_file: 'Read',
  readFile: 'Read',
  write_file: 'Write',
  writeFile: 'Write',
  search_files: 'Grep',
  searchFiles: 'Grep',
  list_files: 'Glob',
  listFiles: 'Glob',
  update_plan: 'TodoWrite',
  updatePlan: 'TodoWrite',
  read_plan: 'TodoRead',
  readPlan: 'TodoRead',
  fetch: 'WebFetch',
  web_fetch: 'WebFetch',
  webFetch: 'WebFetch',
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.text ? p.text || '' : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object' && content.text) return content.text
  return ''
}

function systemBlocks(system) {
  if (system == null) return []
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b && b.text != null ? b : null))
      .filter(Boolean)
  }
  return []
}

export function classifySystemText(text) {
  const t = String(text || '').trim()
  if (!t) return 'empty'
  if (OFFICIAL_IDENTITY.some((re) => re.test(t))) return 'official'
  if (OFFICIAL_CWD.test(t)) return 'official_cwd'
  if (FOREIGN_IDENTITY.some((re) => re.test(t))) return 'foreign_identity'
  return 'keep'
}

export function officialTextBlock(text, { cache = true } = {}) {
  const block = { type: 'text', text: String(text || '').trim() }
  if (cache) block.cache_control = { type: 'ephemeral' }
  return block
}

export function extractCwd(text) {
  const t = String(text || '')
  const patterns = [
    /Current working directory:\s*(.+)/i,
    /^CWD:\s*(.+)$/im,
    /<cwd>\s*([^<]+)\s*<\/cwd>/i,
    /working directory is\s+([^\n]+)/i,
    /Primary working directory:\s*(.+)/i,
    /workspace(?: root)?:\s*(\/[^\n]+)/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m && m[1]) return m[1].trim()
  }
  return ''
}

function stripCwdLines(text) {
  return String(text || '')
    .replace(/^\s*Current working directory:\s*.+$/im, '')
    .replace(/^\s*CWD:\s*.+$/im, '')
    .replace(/^\s*Date:\s*\d{4}-\d{2}-\d{2}\s*$/im, '')
    .replace(/^\s*Primary working directory:\s*.+$/im, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function remapToolName(name) {
  if (!name) return name
  return CODEX_TOOL_MAP[name] || name
}

/**
 * @param {object} body converted Messages-shaped body
 * @returns {{ body: object, prompt: string, decisions: object[], stripped: string[] }}
 */
export function prepareForVmClaude(body) {
  const decisions = []
  const stripped = []
  if (!body || typeof body !== 'object') {
    return { body: body || {}, prompt: 'Hello', decisions, stripped }
  }

  const next = { ...body }

  // Keep tools — do not strip to text-only. Remap known Codex names to official Claude Code tools.
  if (next.tools) {
    const before = Array.isArray(next.tools) ? next.tools : [next.tools]
    next.tools = remapCodexTools(next.tools)
    const names = (Array.isArray(next.tools) ? next.tools : []).map((t) => t?.name || t?.function?.name).filter(Boolean)
    decisions.push({
      action: 'keep_client_tools',
      count: before.length,
      names,
    })
  }

  for (const k of Object.keys(next)) {
    if (!ALLOWED_TOP.has(k)) {
      delete next[k]
      stripped.push(k)
    }
  }
  if (stripped.length) decisions.push({ action: 'strip_unofficial_fields', fields: stripped })

  const blocks = systemBlocks(next.system)
  const official = []
  let cwd = ''
  const date = new Date().toISOString().slice(0, 10)

  for (const b of blocks) {
    const text = String(b.text || '')
    const found = extractCwd(text)
    if (found && !cwd) cwd = found
    const kind = classifySystemText(text)

    if (kind === 'official') {
      decisions.push({ action: 'strip_official_identity', preview: text.slice(0, 120) })
      continue
    }

    if (kind === 'official_cwd') {
      decisions.push({ action: 'keep_official_cwd', cwd: found || cwd })
      continue
    }

    // foreign 人设 + leftover / unknown harness context → official system text blocks
    const persona = stripCwdLines(text)
    if (persona) {
      official.push(officialTextBlock(persona))
      decisions.push({
        action: 'append_persona_as_official_system',
        source: kind,
        preview: persona.slice(0, 160),
        len: persona.length,
      })
    }
  }

  if (cwd) {
    official.unshift(officialTextBlock(`CWD: ${cwd}\nDate: ${date}`))
    decisions.push({ action: 'append_official_cwd', cwd, date })
  }

  if (official.length) next.system = official
  else delete next.system

  let messages = Array.isArray(next.messages) ? [...next.messages] : []
  messages = messages.filter((m) => m && m.role !== 'system' && m.role !== 'developer')
  next.messages = messages

  const prompt = messagesToUserPrompt(next)
  decisions.push({ action: 'prompt_ready', prompt_len: prompt.length, prompt_preview: prompt.slice(0, 200) })
  return { body: next, prompt, decisions, stripped }
}

export function messagesToUserPrompt(body) {
  const parts = []
  const sys = body?.system
  if (typeof sys === 'string' && sys.trim()) parts.push(sys.trim())
  else if (Array.isArray(sys)) {
    const t = sys.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n')
    if (t) parts.push(t)
  }
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  for (const m of msgs) {
    const text = contentText(m.content).trim()
    if (!text) continue
    const role = m.role || 'user'
    if (role === 'assistant') parts.push(`Assistant: ${text}`)
    else parts.push(text)
  }
  return parts.join('\n\n').trim() || 'Hello'
}

export function remapCodexTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t
    if (t.name) return { ...t, name: remapToolName(t.name) }
    if (t.function?.name) {
      return { ...t, function: { ...t.function, name: remapToolName(t.function.name) } }
    }
    return t
  })
}
