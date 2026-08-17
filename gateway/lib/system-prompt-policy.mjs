/**
 * System prompt policy for non–Claude-Code clients.
 *
 * Official Claude Code (2.1.233) wire format — top-level `system` is an array
 * of text blocks:
 *   [0] x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-cli;
 *   [1] You are a Claude agent, built on Anthropic's Claude Agent SDK.
 *   [2] CWD: <dir>\nDate: <YYYY-MM-DD>
 */

const FOREIGN_CLI_PATTERNS = [
  /you are chatgpt/i,
  /you are a coding assistant.*openai/i,
  /openai.*codex/i,
  /codex cli/i,
  /powered by gpt/i,
  /claude code is/i,
  /you are claude code/i,
  /anthropic.*claude code/i,
  /do not mention.*system prompt/i,
  /guideline.*tool use.*openai/i,
  /you are a coding agent/i,
  /codex_exec/i,
  /operating inside pi/i,
  /pi-coding-agent/i,
  /pi, a coding agent harness/i,
  /you are an expert coding assistant/i,
]

const CC_VERSION = '2.1.233'
const CC_ENTRYPOINT = 'sdk-cli'
const CC_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

/**
 * @param {object} body - OpenAI chat or Claude body
 * @param {{ mode?: 'inspect'|'strip'|'strict'|'rewrite-cc', source?: string }} opts
 */
export function applySystemPromptPolicy(body, opts = {}) {
  const mode = opts.mode || 'off'
  const decisions = []

  if (!body || typeof body !== 'object') {
    return { body, decisions }
  }
  if (mode === 'off' || mode === 'none' || mode === 'disabled') {
    return { body, decisions: [{ action: 'off', note: 'system policy disabled' }] }
  }

  if (mode === 'rewrite-cc' || mode === 'rewrite') {
    return rewriteToClaudeCodeSystem(body, { source: opts.source, ccVersion: opts.ccVersion })
  }

  if (Array.isArray(body.messages)) {
    const next = []
    for (const m of body.messages) {
      if (m.role !== 'system' && m.role !== 'developer') {
        next.push(m)
        continue
      }
      const text = contentText(m.content)
      const verdict = classifySystemText(text, opts.source)
      decisions.push({ role: m.role, verdict, preview: text.slice(0, 160) })

      if (mode === 'inspect') {
        next.push(m)
        continue
      }
      if (verdict.action === 'strip' || (mode === 'strict' && verdict.action !== 'keep')) {
        continue
      }
      if (verdict.action === 'rewrite' && verdict.rewritten) {
        next.push({ ...m, content: verdict.rewritten })
        continue
      }
      next.push(m)
    }
    body = { ...body, messages: next }
  }

  if (body.system != null) {
    const text = contentText(body.system)
    const verdict = classifySystemText(text, opts.source)
    decisions.push({ role: 'system(top)', verdict, preview: text.slice(0, 160) })
    if (mode === 'strip' && verdict.action === 'strip') {
      const { system, ...rest } = body
      body = rest
    } else if (mode === 'strict' && verdict.action !== 'keep') {
      const { system, ...rest } = body
      body = rest
    } else if (verdict.action === 'rewrite' && verdict.rewritten) {
      body = { ...body, system: verdict.rewritten }
    }
  }

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    const text = body.instructions
    const verdict = classifySystemText(text, opts.source)
    decisions.push({ role: 'instructions', verdict, preview: text.slice(0, 160) })
    if (mode === 'strip' && verdict.action === 'strip') {
      const { instructions, ...rest } = body
      body = rest
    } else if (mode === 'strict' && verdict.action !== 'keep') {
      const { instructions, ...rest } = body
      body = rest
    } else if (verdict.action === 'rewrite' && verdict.rewritten) {
      body = { ...body, instructions: verdict.rewritten }
    }
  }

  return { body, decisions }
}

export function officialClaudeCodeSystem({ cwd, date, ccVersion } = {}) {
  const version = ccVersion || CC_VERSION
  const day = date || new Date().toISOString().slice(0, 10)
  const workdir = cwd || '/'
  return [
    {
      type: 'text',
      text: `x-anthropic-billing-header: cc_version=${version}.bf9; cc_entrypoint=${CC_ENTRYPOINT};`,
    },
    {
      type: 'text',
      text: CC_IDENTITY,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `CWD: ${workdir}\nDate: ${day}`,
      cache_control: { type: 'ephemeral' },
    },
  ]
}

/**
 * Replace any inbound system / developer / instructions blob with the official
 * Claude Code 3-block system. Keeps user/assistant/tool messages.
 */
export function rewriteToClaudeCodeSystem(body, opts = {}) {
  const inbound = collectSystemText(body)
  const cwd = extractCwd(inbound) || opts.cwd || '/'
  const date = opts.date || new Date().toISOString().slice(0, 10)
  const system = officialClaudeCodeSystem({ cwd, date, ccVersion: opts.ccVersion })

  const next = { ...body }
  next.system = system
  if (typeof next.instructions === 'string') delete next.instructions

  if (Array.isArray(next.messages)) {
    next.messages = next.messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.filter((m) => m.role !== 'system' && m.role !== 'developer')
  }

  return {
    body: next,
    decisions: [
      {
        action: 'rewrite-cc',
        source: opts.source || 'unknown',
        inbound_preview: inbound.slice(0, 240),
        inbound_len: inbound.length,
        cwd,
        date,
        egress_blocks: system.map((b) => b.text.slice(0, 120)),
      },
    ],
    system_final: system,
  }
}

function collectSystemText(body) {
  const parts = []
  if (body?.system != null) parts.push(contentText(body.system))
  if (typeof body?.instructions === 'string') parts.push(body.instructions)
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (m.role === 'system' || m.role === 'developer') parts.push(contentText(m.content))
    }
  }
  if (Array.isArray(body?.input)) {
    for (const m of body.input) {
      if (m.role === 'system' || m.role === 'developer') {
        const c = m.content
        if (typeof c === 'string') parts.push(c)
        else if (Array.isArray(c)) {
          parts.push(c.map((x) => x?.text || '').join('\n'))
        }
      }
    }
  }
  return parts.filter(Boolean).join('\n')
}

function extractCwd(text) {
  const t = String(text || '')
  const patterns = [
    /Current working directory:\s*(.+)/i,
    /^CWD:\s*(.+)$/im,
    /<cwd>\s*([^<]+)\s*<\/cwd>/i,
    /working directory is\s+([^\n]+)/i,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m && m[1]) return m[1].trim()
  }
  return ''
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text || ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object' && content.text) return content.text
  return String(content ?? '')
}

function classifySystemText(text, source) {
  const t = text || ''
  if (!t.trim()) return { action: 'strip', reason: 'empty' }

  for (const re of FOREIGN_CLI_PATTERNS) {
    if (re.test(t)) {
      return {
        action: 'strip',
        reason: `foreign_cli_pattern:${re}`,
        source: source || 'unknown',
      }
    }
  }

  if (t.length > 4000) {
    return {
      action: 'keep',
      reason: 'long_system_audited',
      warning: 'system_prompt_very_long',
      length: t.length,
    }
  }

  return { action: 'keep', reason: 'user_or_benign' }
}

export function extractSystemAudit(body) {
  const blocks = []
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (m.role === 'system' || m.role === 'developer') {
        blocks.push({ role: m.role, text: contentText(m.content).slice(0, 500) })
      }
    }
  }
  if (body?.system != null) {
    blocks.push({ role: 'system(top)', text: contentText(body.system).slice(0, 500) })
  }
  return blocks
}
