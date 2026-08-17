import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'
const CLAUDE_WEB = 'https://claude.ai'
// Prefer api.anthropic.com for token exchange (avoids CF managed challenge on console/platform)
const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://api.anthropic.com/v1/oauth/token',
]

const SCOPE_API =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const SCOPE_INFERENCE = 'user:inference'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function generateState() {
  return b64url(crypto.randomBytes(32))
}

function generateCodeVerifier() {
  return b64url(crypto.randomBytes(32))
}

function generateCodeChallenge(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier).digest())
}

function redact(s, keep = 12) {
  if (!s || typeof s !== 'string') return s
  if (s.length <= keep * 2) return s.slice(0, 4) + '…'
  return s.slice(0, keep) + '…' + s.slice(-8)
}

async function fetchJson(url, options = {}, proxyUrl = null) {
  const [{ default: fetch }, { SocksProxyAgent }] = await Promise.all([
    import('node-fetch'),
    import('socks-proxy-agent'),
  ])
  const opts = {
    ...options,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ...(options.headers || {}),
    },
  }
  const px = proxyUrl || _activeProxyUrl
  if (px) {
    opts.agent = new SocksProxyAgent(px)
  }
  const res = await fetch(url, opts)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body, text, headers: res.headers }
}

/**
 * Step 1: resolve organization UUID via sessionKey cookie
 */
let _activeProxyUrl = null

async function getOrganizationUUID(sessionKey) {
  const url = `${CLAUDE_WEB}/api/organizations`
  console.log('[1/3] GET', url)
  const { ok, status, body, text } = await fetchJson(url, {
    method: 'GET',
    headers: {
      Cookie: `sessionKey=${sessionKey}`,
      Origin: 'https://claude.ai',
      Referer: 'https://claude.ai/new',
    },
  })
  if (!ok) {
    throw new Error(`get organizations failed: ${status} ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`)
  }
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error(`no organizations found: ${JSON.stringify(body).slice(0, 300)}`)
  }
  // Prefer team org when present (sub2api behavior)
  const team = body.find((o) => o.raven_type === 'team')
  const org = team || body[0]
  console.log('[1/3] org uuid=', org.uuid, 'name=', org.name, 'raven_type=', org.raven_type ?? null)
  return org.uuid
}

/**
 * Step 2: request authorization code using sessionKey (no browser)
 */
async function getAuthorizationCode(sessionKey, orgUUID, scope, codeChallenge, state) {
  const url = `${CLAUDE_WEB}/v1/oauth/${orgUUID}/authorize`
  const reqBody = {
    response_type: 'code',
    client_id: CLIENT_ID,
    organization_uuid: orgUUID,
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }
  console.log('[2/3] POST', url)
  const { ok, status, body, text } = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `sessionKey=${sessionKey}`,
      Origin: 'https://claude.ai',
      Referer: 'https://claude.ai/new',
      'Cache-Control': 'no-cache',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify(reqBody),
  })
  if (!ok) {
    throw new Error(
      `authorize failed: ${status} ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`,
    )
  }
  const redirectURI = body?.redirect_uri
  if (!redirectURI) {
    throw new Error(`no redirect_uri in authorize response: ${JSON.stringify(body).slice(0, 400)}`)
  }
  const parsed = new URL(redirectURI)
  const authCode = parsed.searchParams.get('code')
  const responseState = parsed.searchParams.get('state')
  if (!authCode) {
    throw new Error(`no code in redirect_uri: ${redirectURI}`)
  }
  const fullCode = responseState ? `${authCode}#${responseState}` : authCode
  console.log('[2/3] got authorization code', redact(authCode, 8))
  return fullCode
}

/**
 * Step 3: exchange code for access/refresh tokens
 */
async function exchangeCodeForToken(fullCode, codeVerifier) {
  let authCode = fullCode
  let codeState = ''
  const idx = fullCode.indexOf('#')
  if (idx !== -1) {
    authCode = fullCode.slice(0, idx)
    codeState = fullCode.slice(idx + 1)
  }
  const reqBody = {
    code: authCode,
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  }
  if (codeState) reqBody.state = codeState

  let lastErr
  for (const tokenURL of TOKEN_URLS) {
    console.log('[3/3] POST', tokenURL)
    try {
      const { ok, status, body, text } = await fetchJson(tokenURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify(reqBody),
      })
      if (!ok) {
        lastErr = new Error(`token exchange failed @ ${tokenURL}: ${status} ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`)
        console.warn('[3/3]', lastErr.message)
        continue
      }
      if (!body?.access_token) {
        lastErr = new Error(`no access_token in response: ${JSON.stringify(body).slice(0, 400)}`)
        continue
      }
      console.log('[3/3] SUCCESS access_token=', redact(body.access_token))
      return body
    } catch (e) {
      lastErr = e
      console.warn('[3/3] error', e.message)
    }
  }
  throw lastErr || new Error('token exchange failed on all endpoints')
}

/**
 * DISABLED permanently.
 *
 * KIN must never call grant_type=refresh_token — that races the VM official
 * Claude Code which owns credentials.json rotation. Recovery path is:
 *   stored sessionKey → CookieAuth re-import only.
 */
export async function refreshOAuthToken() {
  const err = new Error(
    'KIN_REFRESH_TOKEN_DISABLED: gateway never calls grant_type=refresh_token. Re-import sessionKey or let VM Claude Code refresh.',
  )
  err.code = 'refresh_token_disabled'
  err.need_reimport = true
  throw err
}

function findCffiHelper() {
  const candidates = [
    path.join(__dirname, 'scripts', 'session-import-cffi.py'),
    path.join(__dirname, '..', 'scripts', 'session-import-cffi.py'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

function normalizeSocks(proxyUrl) {
  if (!proxyUrl) return null
  const s = String(proxyUrl)
  if (s.startsWith('socks5://') && !s.startsWith('socks5h://')) {
    return 'socks5h://' + s.slice('socks5://'.length)
  }
  return s
}

function spawnCffiImport(sessionKey, { scope = 'full', proxyUrl = null } = {}) {
  const helper = findCffiHelper()
  if (!helper) {
    const err = new Error('session-import-cffi.py not found')
    err.code = 'no_cffi_helper'
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper], {
      env: {
        ...process.env,
        SESSION_KEY: sessionKey,
        SCOPE: scope,
        PROXY_URL: normalizeSocks(proxyUrl) || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (stderr.trim()) console.warn('[cffi-import]', stderr.trim().slice(0, 800))
      if (code !== 0) {
        const err = new Error(`cffi import exited ${code}: ${stderr.trim().slice(-300)}`)
        err.code = 'cffi_import_failed'
        reject(err)
        return
      }
      try {
        const cred = JSON.parse(stdout.trim())
        if (!cred?.access_token) throw new Error('cffi import returned no access_token')
        resolve(cred)
      } catch (e) {
        reject(e)
      }
    })
  })
}

async function sessionKeyToOAuthNode(sessionKey, { scope = 'full', proxyUrl = null } = {}) {
  _activeProxyUrl = proxyUrl || null
  const sk = String(sessionKey || '').trim()
  if (!sk.startsWith('sk-ant-sid')) {
    throw new Error(`expected sk-ant-sid* sessionKey, got: ${redact(sk)}`)
  }

  const oauthScope = scope === 'inference' ? SCOPE_INFERENCE : SCOPE_API
  const orgUUID = await getOrganizationUUID(sk)

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  const fullCode = await getAuthorizationCode(sk, orgUUID, oauthScope, codeChallenge, state)
  const tokenResp = await exchangeCodeForToken(fullCode, codeVerifier)

  const expiresIn = Number(tokenResp.expires_in || 0)
  const now = Math.floor(Date.now() / 1000)
  const credential = {
    type: scope === 'inference' ? 'setup-token' : 'oauth',
    platform: 'anthropic',
    access_token: tokenResp.access_token,
    refresh_token: tokenResp.refresh_token || '',
    token_type: tokenResp.token_type || 'Bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    scope: tokenResp.scope || oauthScope,
    org_uuid: tokenResp.organization?.uuid || orgUUID,
    account_uuid: tokenResp.account?.uuid || '',
    email_address: tokenResp.account?.email_address || '',
    source: 'sessionKey-cookie-auth',
    converted_at: new Date().toISOString(),
  }
  _activeProxyUrl = null
  return credential
}

/**
 * Full conversion: sessionKey → OAuth credential object.
 * Prefers curl_cffi Chrome TLS (claude.ai is CF-gated). node-fetch is fallback.
 */
export async function sessionKeyToOAuth(sessionKey, { scope = 'full', proxyUrl = null } = {}) {
  const sk = String(sessionKey || '').trim()
  if (!sk.startsWith('sk-ant-sid')) {
    throw new Error(`expected sk-ant-sid* sessionKey, got: ${redact(sk)}`)
  }
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    const now = Math.floor(Date.now() / 1000)
    return {
      access_token: 'sk-ant-oat01-FAKE-SIM',
      refresh_token: 'sk-ant-ort01-FAKE-SIM',
      expires_at: now + 8 * 3600,
      expiresAt: (now + 8 * 3600) * 1000,
      email: 'fake-oauth@kin.test',
      account_uuid: 'acct-fake-sim',
      org_uuid: 'org-fake-sim',
      source: 'KIN_FAKE_SESSION_OAUTH',
      scope,
    }
  }
  const proxies = []
  const px = normalizeSocks(proxyUrl)
  if (px) proxies.push(px)
  proxies.push(null) // VPS chrome TLS can reach claude.ai without SOCKS
  let lastErr
  for (const p of proxies) {
    try {
      const cred = await spawnCffiImport(sk, { scope, proxyUrl: p })
      console.log('[import] via curl_cffi chrome TLS', p ? 'socks5h' : 'direct', redact(cred.access_token || ''))
      return cred
    } catch (e) {
      lastErr = e
      console.warn('[import] curl_cffi', p ? 'socks5h' : 'direct', 'failed:', e.message)
    }
  }
  console.warn('[import] curl_cffi exhausted, falling back to node-fetch:', lastErr?.message)
  return sessionKeyToOAuthNode(sk, { scope, proxyUrl: px })
}

import { pathToFileURL } from "node:url"

const isMain = !!(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
if (isMain) {
  const sessionKey = process.env.SESSION_KEY || process.argv[2]
  const scope = process.env.SCOPE || process.argv[3] || "full"
  if (!sessionKey) {
    console.error("Usage: node session-to-oauth.mjs <sessionKey> [full|inference]")
    process.exit(1)
  }
  console.log("=== KIN sessionKey → OAuth converter ===")
  console.log("sessionKey:", redact(sessionKey))
  console.log("scope:", scope)
  try {
    const cred = await sessionKeyToOAuth(sessionKey, { scope, proxyUrl: process.env.PROXY_URL || null })
    const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "out")
    fs.mkdirSync(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const fullPath = path.join(outDir, `oauth-${stamp}.json`)
    fs.writeFileSync(fullPath, JSON.stringify(cred, null, 2), { mode: 0o600 })
    const preview = {
      ...cred,
      access_token: redact(cred.access_token),
      refresh_token: redact(cred.refresh_token),
    }
    console.log("\n=== RESULT (redacted) ===")
    console.log(JSON.stringify(preview, null, 2))
    console.log("\nFull credential saved to:", fullPath)
    fs.writeFileSync(path.join(outDir, "oauth-latest.json"), JSON.stringify(cred, null, 2), { mode: 0o600 })
    fs.writeFileSync(path.join(outDir, "oauth-latest.redacted.json"), JSON.stringify(preview, null, 2))
  } catch (e) {
    console.error("\nCONVERSION FAILED:", e.message)
    process.exit(2)
  }
}
