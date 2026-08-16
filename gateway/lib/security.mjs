import crypto from 'node:crypto'

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
    return auth.slice(7).trim()
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
    password: process.env.KIN_ADMIN_PASSWORD || 'change-me',
  }
}

const panelSessions = new Map() // token -> { user, exp }

export function createPanelSession(username, ttlMs = 7 * 24 * 3600 * 1000) {
  const token = 'kin-panel-' + crypto.randomBytes(24).toString('hex')
  panelSessions.set(token, { user: username, exp: Date.now() + ttlMs })
  return token
}

export function verifyPanelSession(token) {
  if (!token || !token.startsWith('kin-panel-')) return null
  const s = panelSessions.get(token)
  if (!s) return null
  if (Date.now() > s.exp) {
    panelSessions.delete(token)
    return null
  }
  return s
}

export function revokePanelSession(token) {
  panelSessions.delete(token)
}

export function verifyPanelLogin(username, password) {
  const admin = getPanelAdmin()
  if (!timingSafeEqualStr(String(username || ''), admin.username)) return false
  if (!timingSafeEqualStr(String(password || ''), admin.password)) return false
  return true
}

/** Extract panel session or API key from request */
export function extractPanelToken(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  if (req.headers['x-panel-token']) return String(req.headers['x-panel-token']).trim()
  return ''
}
