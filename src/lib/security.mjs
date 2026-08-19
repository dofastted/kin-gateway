import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex')
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function redactSecrets(obj) {
  const s = JSON.stringify(obj)
  return s
    .replace(/sk-ant-[a-z0-9-]{8,}/gi, (m) => m.slice(0, 14) + '***REDACTED***')
    .replace(/sk-kin-[a-f0-9]{8,}/gi, (m) => m.slice(0, 10) + '***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***REDACTED***')
}

export function extractApiKey(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    // panel session tokens are not API keys
    if (t.startsWith('kin-panel-')) return ''
    return t
  }
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim()
  return ''
}

/** Simple token bucket per key */
export function createRateLimiter({ capacity = 60, refillPerSec = 1 } = {}) {
  const buckets = new Map()
  return function allow(key) {
    const now = Date.now()
    let b = buckets.get(key)
    if (!b) {
      b = { tokens: capacity, updated: now }
      buckets.set(key, b)
    }
    const elapsed = (now - b.updated) / 1000
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec)
    b.updated = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
}

export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

/** Panel admin credentials (env override) */
export function getPanelAdmin() {
  return {
    username: process.env.KIN_ADMIN_USER || 'admin',
    password: process.env.KIN_ADMIN_PASSWORD || '',
  }
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const panelSessions = new Map() // sha256(token) -> { user, exp }

function panelSessionKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function sessionFile() {
  const dir = process.env.KIN_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dir, 'panel-sessions.json')
}

function loadSessions() {
  try {
    const f = sessionFile()
    if (!fs.existsSync(f)) return
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    const now = Date.now()
    for (const [storedKey, s] of Object.entries(raw || {})) {
      if (s && s.exp > now) {
        const key = storedKey.startsWith('kin-panel-')
          ? panelSessionKey(storedKey)
          : storedKey
        panelSessions.set(key, { user: s.user, exp: s.exp })
      }
    }
  } catch {}
}

function saveSessions() {
  try {
    const f = sessionFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const obj = {}
    const now = Date.now()
    for (const [token, s] of panelSessions.entries()) {
      if (s.exp > now) obj[token] = s
    }
    fs.writeFileSync(f, JSON.stringify(obj, null, 2))
  } catch {}
}

loadSessions()

export function createPanelSession(username, ttlMs = SESSION_TTL_MS) {
  const token = 'kin-panel-' + crypto.randomBytes(24).toString('hex')
  panelSessions.set(panelSessionKey(token), { user: username, exp: Date.now() + ttlMs })
  saveSessions()
  return token
}

export function verifyPanelSession(token) {
  if (!token || !token.startsWith('kin-panel-')) return null
  const key = panelSessionKey(token)
  let s = panelSessions.get(key)
  if (!s) {
    // reload from disk once (multi-process / restart)
    loadSessions()
    s = panelSessions.get(key)
  }
  if (!s) return null
  if (Date.now() > s.exp) {
    panelSessions.delete(key)
    saveSessions()
    return null
  }
  return s
}

export function revokePanelSession(token) {
  if (!token) return
  panelSessions.delete(panelSessionKey(token))
  saveSessions()
}

export function verifyPanelLogin(username, password) {
  const admin = getPanelAdmin()
  if (!timingSafeEqualStr(String(username || ''), admin.username)) return false
  if (!timingSafeEqualStr(String(password || ''), admin.password)) return false
  return true
}

function parseCookie(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/** Extract panel session token: Bearer → x-panel-token → Cookie */
export function extractPanelToken(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim()
    if (t.startsWith('kin-panel-')) return t
  }
  if (req.headers['x-panel-token']) {
    const t = String(req.headers['x-panel-token']).trim()
    if (t) return t
  }
  const cookies = parseCookie(req.headers.cookie)
  if (cookies.kin_panel_token) return cookies.kin_panel_token
  if (cookies.kin_console_token) return cookies.kin_console_token
  return ''
}

/** Build Set-Cookie for panel session (7d) */
export function panelSessionCookie(token, { secure = true, maxAgeSec = 7 * 24 * 3600 } = {}) {
  const parts = [
    `kin_panel_token=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearPanelSessionCookie({ secure = true } = {}) {
  const parts = [
    'kin_panel_token=',
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
