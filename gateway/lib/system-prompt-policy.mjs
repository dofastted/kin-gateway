/**
 * System prompt policy for non–Claude-Code clients.
 *
 * Rules (default):
 * 1. Inspect all system / developer messages
 * 2. Strip known foreign CLI attribution / bootstrap blocks
 * 3. Optionally rewrite or reject if policy=strict
 * 4. Log decisions for audit
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
]

const CLAUDE_CODE_ATTRIBUTION = [
  /claude code/i,
  /anthropic\.com/i,
]

/**
 * @param {object} body - OpenAI chat or Claude body
 * @param {{ mode?: 'inspect'|'strip'|'strict', source?: string }} opts
 * @returns {{ body, decisions: Array, system_final?: string }}
 */
export function applySystemPromptPolicy(body, opts = {}) {
  const mode = opts.mode || 'off' // default OFF: never mutate system/developer text
  const decisions = []

  if (!body || typeof body !== 'object') {
    return { body, decisions }
  }
  if (mode === 'off' || mode === 'none' || mode === 'disabled') {
    return { body, decisions: [{ action: 'off', note: 'system policy disabled' }] }
  }

  // OpenAI-style messages
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
        // drop this system message
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

  // Claude-style top-level system
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


  // OpenAI Responses / Codex: instructions acts as system
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

  // Long bootstrap prompts from agent CLIs (>2k) — tag for audit, keep by default
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
