/**
 * Unofficial OAuth outbound persona. Official Claude Code inbound is
 * never rewritten. Mode comes from routing.compatibility.persona_inject:
 *   rewrite — official 3-block system (billing + identity + expansion) [default]
 *   append  — attach the official one-liner to the caller system
 *   none    — leave system / messages untouched
 * routing.compatibility.persona_park (rewrite only):
 *   true  — park leftover caller system as mid-conversation role:system
 *           after the first user turn (CLIProxy) [default]
 *   false — drop caller system
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'

export const CRS_OFFICIAL_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
export const DEFAULT_CLI_VERSION = '2.1.234'
export const PERSONA_MODES = Object.freeze(['rewrite', 'append', 'none'])
export const DEFAULT_PERSONA_MODE = 'rewrite'
export const DEFAULT_PERSONA_PARK = true
export const DEFAULT_CACHE_CONTROL_TTL = '5m'
export const FINGERPRINT_SALT = '59cf53e54c78'
export const SYSTEM_INSTRUCTIONS_PREFIX = '[System Instructions]\n'
export const SYSTEM_INSTRUCTIONS_ACK = 'Understood. I will follow these instructions.'

// sub2api claudeCodeSystemPromptExpansion — identity/security/tone only.
// No # System tool-permission block, # Doing tasks, /help, or # Output efficiency.
export const CRS_SYSTEM_EXPANSION = `You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

# Tone and style
 - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
 - Your responses should be short and concise.
 - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
 - When referencing GitHub issues or pull requests, use the owner/repo#123 format (e.g. anthropics/claude-code#100) so they render as clickable links.
 - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`

export function systemToText(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n')
  }
  return system.text || ''
}

export function hasOfficialClaudeLine(system) {
  return systemToText(system).includes(CRS_OFFICIAL_SYSTEM)
}

export function parseCliVersion(input) {
  if (input == null || input === '') return DEFAULT_CLI_VERSION
  const m = String(input).match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : DEFAULT_CLI_VERSION
}

export function extractFirstUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (msg?.role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') return block
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
      }
      return ''
    }
    return ''
  }
  return ''
}

export function computeClaudeCodeFingerprint(firstUserText = '', cliVersion = DEFAULT_CLI_VERSION) {
  const buf = Buffer.from(String(firstUserText), 'utf8')
  let chars = ''
  for (const i of [4, 7, 20]) {
    chars += i < buf.length ? String.fromCharCode(buf[i]) : '0'
  }
  return createHash('sha256').update(FINGERPRINT_SALT + chars + cliVersion, 'utf8').digest('hex').slice(0, 3)
}

export function buildBillingAttributionText(firstUserText, cliVersion = DEFAULT_CLI_VERSION) {
  const ver = parseCliVersion(cliVersion)
  const fp = computeClaudeCodeFingerprint(firstUserText ?? '', ver)
  return `x-anthropic-billing-header: cc_version=${ver}.${fp}; cc_entrypoint=cli;`
}

function extractSystemTexts(system) {
  if (!system) return []
  if (typeof system === 'string') return [system]
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter((t) => String(t).trim())
  }
  if (typeof system === 'object' && typeof system.text === 'string') return [system.text]
  return []
}

function isBillingLine(text) {
  return /^\s*x-anthropic-billing-header:/i.test(text)
}

function isStandaloneOfficialLine(text) {
  return String(text).trim() === CRS_OFFICIAL_SYSTEM
}

export function parkableSystemTexts(system) {
  const kept = []
  for (const raw of extractSystemTexts(system)) {
    const paragraphs = String(raw).split(/\n\n+/)
      .map((p) => p.split('\n').filter((line) => !isBillingLine(line)).join('\n').trim())
      .filter((p) => p && !isStandaloneOfficialLine(p))
    if (paragraphs.length) kept.push(paragraphs.join('\n\n'))
  }
  return kept
}

export function parkableSystemText(system) {
  return parkableSystemTexts(system).join('\n\n')
}

function buildThreeBlocks(firstUserText, cliVersion) {
  return [
    { type: 'text', text: buildBillingAttributionText(firstUserText, cliVersion) },
    { type: 'text', text: CRS_OFFICIAL_SYSTEM },
    { type: 'text', text: CRS_SYSTEM_EXPANSION, cache_control: { type: 'ephemeral', ttl: DEFAULT_CACHE_CONTROL_TTL } },
  ]
}

export function normalizePersonaMode(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'none' || raw === 'off' || raw === 'false' || raw === '0' || raw === 'disable' || raw === 'disabled') return 'none'
  if (raw === 'append' || raw === 'add' || raw === 'attach') return 'append'
  if (raw === 'rewrite' || raw === 'replace' || raw === 'overwrite' || raw === 'cover') return 'rewrite'
  return DEFAULT_PERSONA_MODE
}

export function personaModeFromRouting(routing = {}) {
  return normalizePersonaMode(routing?.compatibility?.persona_inject)
}

export function normalizePersonaPark(value) {
  if (value === false || value === 0) return false
  if (value === true || value === 1) return true
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no' || raw === 'drop') return false
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes' || raw === 'park') return true
  return DEFAULT_PERSONA_PARK
}

export function personaParkFromRouting(routing = {}) {
  return normalizePersonaPark(routing?.compatibility?.persona_park)
}

export function personaOptionsFromRouting(routing = {}) {
  return {
    mode: personaModeFromRouting(routing),
    park: personaParkFromRouting(routing),
  }
}

/** Re-read routing.json so scp of persona_inject / persona_park applies without a Node restart. */
export function personaModeFromRoutingFile(filePath) {
  return personaOptionsFromRoutingFile(filePath).mode
}

export function personaParkFromRoutingFile(filePath) {
  return personaOptionsFromRoutingFile(filePath).park
}

export function personaOptionsFromRoutingFile(filePath) {
  if (!filePath) return { mode: DEFAULT_PERSONA_MODE, park: DEFAULT_PERSONA_PARK }
  try {
    return personaOptionsFromRouting(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return { mode: DEFAULT_PERSONA_MODE, park: DEFAULT_PERSONA_PARK }
  }
}

const CLAUDE_CLI_UA_RE = /^claude-cli\/\d+\.\d+\.\d+/i
const LEGACY_OFFICIAL_USER_ID_RE = /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/

export function isValidOfficialUserId(raw) {
  if (raw == null) return false
  if (typeof raw === 'object') {
    return !!(raw.device_id && raw.session_id)
  }
  const s = String(raw).trim()
  if (!s) return false
  if (s.startsWith('{')) {
    try {
      const p = JSON.parse(s)
      return !!(p && p.device_id && p.session_id)
    } catch {
      return false
    }
  }
  return LEGACY_OFFICIAL_USER_ID_RE.test(s)
}

/** sub2api-style official Claude Code: UA claude-cli/x.y.z + parseable user_id. */
export function isOfficialClaudeCodeTraffic(headers = {}, body = {}) {
  const ua = String(headers['user-agent'] || headers['User-Agent'] || '').trim()
  if (!CLAUDE_CLI_UA_RE.test(ua)) return false
  return isValidOfficialUserId(body?.metadata?.user_id)
}

function stripSystemCacheControl(body) {
  if (!Array.isArray(body.system)) return body
  let changed = false
  const system = body.system.map((block) => {
    if (!block || typeof block !== 'object' || !block.cache_control) return block
    changed = true
    const next = { ...block }
    delete next.cache_control
    return next
  })
  return changed ? { ...body, system } : body
}

function appendOfficialLine(body) {
  if (hasOfficialClaudeLine(body.system)) return body
  const existing = body.system
  if (!existing) return { ...body, system: CRS_OFFICIAL_SYSTEM }
  if (typeof existing === 'string') {
    return { ...body, system: `${existing.replace(/\s+$/, '')}\n\n${CRS_OFFICIAL_SYSTEM}` }
  }
  if (Array.isArray(existing)) {
    return { ...body, system: [...existing, { type: 'text', text: CRS_OFFICIAL_SYSTEM }] }
  }
  return { ...body, system: CRS_OFFICIAL_SYSTEM }
}

function firstUserIndex(messages) {
  return messages.findIndex((message) => message?.role === 'user')
}

/** CLIProxy: insert after the first user and any immediately following users. */
function insertAfterFirstUserTurn(messages, extras) {
  const first = firstUserIndex(messages)
  if (first < 0 || !extras.length) return messages
  let insertAt = first + 1
  while (insertAt < messages.length && messages[insertAt]?.role === 'user') insertAt += 1
  return [...messages.slice(0, insertAt), ...extras, ...messages.slice(insertAt)]
}

function parkedSystemMessage(text) {
  return {
    role: 'system',
    content: [{
      type: 'text',
      text,
      cache_control: { type: 'ephemeral', ttl: DEFAULT_CACHE_CONTROL_TTL },
    }],
  }
}

function rewriteThreeBlockSystem(body, cliVersion, park = false) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const firstUserText = extractFirstUserText(messages)
  const ver = parseCliVersion(cliVersion)
  const system = buildThreeBlocks(firstUserText, ver)
  if (!park) return { ...body, system, messages }
  const leftovers = parkableSystemTexts(body.system)
  if (!leftovers.length) return { ...body, system, messages }
  return {
    ...body,
    system,
    messages: insertAfterFirstUserTurn(messages, leftovers.map(parkedSystemMessage)),
  }
}

export function applyCrsUnofficialPersona(body, {
  officialClient = false,
  cliVersion,
  mode,
  park,
  routingFile,
  headers,
} = {}) {
  if (!body || typeof body !== 'object') return body
  if (officialClient || isOfficialClaudeCodeTraffic(headers || {}, body)) return body
  const fromFile = routingFile ? personaOptionsFromRoutingFile(routingFile) : null
  const resolved = normalizePersonaMode(mode ?? fromFile?.mode)
  const doPark = park == null
    ? (fromFile ? fromFile.park : DEFAULT_PERSONA_PARK)
    : normalizePersonaPark(park)
  if (resolved === 'none') return stripSystemCacheControl(body)
  if (resolved === 'append') return appendOfficialLine(body)
  return rewriteThreeBlockSystem(body, cliVersion, doPark)
}
