/**
 * Store / replay official Claude Code headers (CRS claudeCodeHeadersService analog).
 * Never stores Authorization / x-api-key / cookies.
 */
import fs from 'node:fs'
import path from 'node:path'

const KEEP = [
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'x-app',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'x-stainless-helper-method',
  'x-claude-code-session-id',
  'accept-language',
  'sec-fetch-mode',
]

const DEFAULTS = {
  'user-agent': 'claude-cli/2.1.234 (external, cli)',
  'anthropic-version': '2023-06-01',
  'x-app': 'cli',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-package-version': '0.112.1',
}

function lowerHeaders(h = {}) {
  const out = {}
  for (const [k, v] of Object.entries(h || {})) {
    if (v == null || v === '') continue
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return out
}

export function extractClaudeCodeHeaders(reqHeaders = {}) {
  const src = lowerHeaders(reqHeaders)
  const out = {}
  for (const k of KEEP) {
    if (src[k] != null) out[k] = src[k]
  }
  return out
}

export function isOfficialClaudeUa(ua = '') {
  return /^claude-cli\//i.test(String(ua || ''))
}

function headerFile(homeDir) {
  return path.join(homeDir, '.claude', 'kin-cc-headers.json')
}

export function storeAccountHeaders(homeDir, reqHeaders = {}) {
  if (!homeDir) return { stored: false }
  const extracted = extractClaudeCodeHeaders(reqHeaders)
  if (!isOfficialClaudeUa(extracted['user-agent'] || '')) return { stored: false }
  try {
    fs.mkdirSync(path.dirname(headerFile(homeDir)), { recursive: true })
    fs.writeFileSync(headerFile(homeDir), JSON.stringify({
      headers: extracted,
      updated_at: new Date().toISOString(),
    }, null, 2))
    return { stored: true }
  } catch {
    return { stored: false }
  }
}

export function loadStoredHeaders(homeDir) {
  if (!homeDir) return null
  try {
    const d = JSON.parse(fs.readFileSync(headerFile(homeDir), 'utf8'))
    return d?.headers && typeof d.headers === 'object' ? d.headers : null
  } catch {
    return null
  }
}

/** VM characteristics are the only fingerprint. Protocol betas may come from official inbound. */
export function resolveVmCharacteristicHeaders(identity = {}, reqHeaders = {}, homeDir = '') {
  const incoming = extractClaudeCodeHeaders(reqHeaders)
  if (isOfficialClaudeUa(incoming['user-agent'] || '')) storeAccountHeaders(homeDir, reqHeaders)
  const stored = loadStoredHeaders(homeDir) || {}
  const fp = identity.fingerprint || {}
  const protocol = {}
  if (incoming['anthropic-version']) protocol['anthropic-version'] = incoming['anthropic-version']
  if (incoming['anthropic-beta']) protocol['anthropic-beta'] = incoming['anthropic-beta']
  if (incoming['anthropic-dangerous-direct-browser-access']) {
    protocol['anthropic-dangerous-direct-browser-access'] = incoming['anthropic-dangerous-direct-browser-access']
  }
  return {
    ...DEFAULTS,
    ...stored,
    ...protocol,
    'user-agent': identity.userAgent || stored['user-agent'] || DEFAULTS['user-agent'],
    'x-app': fp.x_app || 'cli',
    'x-stainless-lang': fp.stainless_lang || stored['x-stainless-lang'] || DEFAULTS['x-stainless-lang'],
    'x-stainless-os': fp.stainless_os || DEFAULTS['x-stainless-os'],
    'x-stainless-arch': fp.stainless_arch || DEFAULTS['x-stainless-arch'],
    'x-stainless-runtime': fp.stainless_runtime || DEFAULTS['x-stainless-runtime'],
    'x-stainless-runtime-version': fp.stainless_runtime_version || stored['x-stainless-runtime-version'] || DEFAULTS['x-stainless-runtime-version'],
    'x-stainless-package-version': fp.stainless_package_version || stored['x-stainless-package-version'] || DEFAULTS['x-stainless-package-version'],
  }
}

/** Official inbound headers win; unofficial clients replay last official set. */
export function resolveCrsHeaders(reqHeaders = {}, homeDir = '', identity = null) {
  if (identity) return resolveVmCharacteristicHeaders(identity, reqHeaders, homeDir)
  const incoming = extractClaudeCodeHeaders(reqHeaders)
  if (isOfficialClaudeUa(incoming['user-agent'] || '')) {
    storeAccountHeaders(homeDir, reqHeaders)
    return { ...DEFAULTS, ...incoming }
  }
  const stored = loadStoredHeaders(homeDir) || {}
  const incomingSafe = { ...incoming }
  delete incomingSafe['user-agent']
  return { ...DEFAULTS, ...stored, ...incomingSafe }
}
