/**
 * Caller-machine environment for client-workspace hops.
 * Only characteristic fields — never OAuth / device identity.
 */

const HEADER_MAP = {
  'x-kin-cwd': 'cwd',
  'x-kin-os': 'os',
  'x-kin-platform': 'os',
  'x-kin-home': 'home',
  'x-kin-user': 'user',
  'x-kin-hostname': 'hostname',
  'x-kin-arch': 'arch',
  'x-kin-workspace-root': 'cwd',
}

function header(req, name) {
  const h = req?.headers || {}
  const v = h[name] || h[name.toLowerCase()]
  return v == null ? '' : String(Array.isArray(v) ? v[0] : v).trim()
}

function systemText(body) {
  const s = body?.system
  if (typeof s === 'string') return s
  if (Array.isArray(s)) {
    return s.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n')
  }
  return ''
}

function take(re, text) {
  const m = String(text || '').match(re)
  return m ? String(m[1] || '').trim() : ''
}

export function extractClientEnv(req = {}, body = {}) {
  const env = {}
  for (const [h, key] of Object.entries(HEADER_MAP)) {
    const v = header(req, h)
    if (v && !env[key]) env[key] = v
  }
  const md = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  const nested = md.kin_client && typeof md.kin_client === 'object' ? md.kin_client : {}
  for (const key of ['cwd', 'os', 'home', 'user', 'hostname', 'arch']) {
    const v = nested[key] || md[key] || md[`client_${key}`]
    if (v && !env[key]) env[key] = String(v).trim()
  }
  const blob = systemText(body)
  if (blob) {
    const cwd = take(/working directory[:：]\s*([^\n\r]+)/i, blob)
      || take(/(?:^|\n)\s*cwd\s*=\s*([^\s\n]+)/i, blob)
    const os = take(/(?:^|\n)\s*os\s*=\s*([A-Za-z0-9._-]+)/i, blob)
    const home = take(/(?:^|\n)\s*home\s*=\s*([^\s\n]+)/i, blob)
    const user = take(/(?:^|\n)\s*user\s*=\s*([A-Za-z0-9._-]+)/i, blob)
    if (cwd && !env.cwd) env.cwd = cwd.replace(/[`'"]/g, '').trim()
    if (os && !env.os) env.os = os
    if (home && !env.home) env.home = home
    if (user && !env.user) env.user = user
  }
  if (env.os) env.os = String(env.os).toLowerCase()
  for (const k of Object.keys(env)) {
    if (!env[k]) delete env[k]
    else env[k] = String(env[k]).slice(0, 512)
  }
  env.source = env.cwd || env.os || env.home ? 'caller' : 'none'
  return env
}

export function formatClientEnvPrompt(env = {}) {
  const lines = [
    '[kin-client-workspace]',
    'You are Claude Code running on the CALLER computer, not inside any container or VM.',
    'Read/Write/Edit/Bash and all file tools execute on the caller. Never use /home/kincli or container paths.',
    'If the user asks to read or write a file, you MUST emit a tool_use immediately. Do not only say you will do it.',
    'If a tool_result is already in the conversation, do not call that same tool/path again; answer from the result.',
  ]
  if (env.os) lines.push(`os=${env.os}`)
  if (env.cwd) lines.push(`cwd=${env.cwd}`)
  if (env.home) lines.push(`home=${env.home}`)
  if (env.user) lines.push(`user=${env.user}`)
  if (env.hostname) lines.push(`hostname=${env.hostname}`)
  if (env.arch) lines.push(`arch=${env.arch}`)
  if (env.cwd) lines.push(`Resolve relative paths against cwd=${env.cwd}.`)
  return lines.join('\n')
}

export function clientEnvSettingsPatch(env = {}) {
  const out = {}
  if (env.cwd) out.KIN_CLIENT_CWD = env.cwd
  if (env.os) out.KIN_CLIENT_OS = env.os
  if (env.home) out.KIN_CLIENT_HOME = env.home
  if (env.user) out.KIN_CLIENT_USER = env.user
  if (env.hostname) out.KIN_CLIENT_HOSTNAME = env.hostname
  if (env.arch) out.KIN_CLIENT_ARCH = env.arch
  return out
}
