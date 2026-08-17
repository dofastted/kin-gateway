/**
 * KIN core: Claude sessionKey (sk-ant-sid*) → official OAuth credentials
 * Migrated from Wei-Shaw/sub2api CookieAuth flow.
 *
 * Flow:
 *  1) GET  claude.ai/api/organizations           (Cookie: sessionKey)
 *  2) POST claude.ai/v1/oauth/{org}/authorize    (Cookie: sessionKey + PKCE)
 *  3) POST platform.claude.com/v1/oauth/token    (authorization_code exchange)
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import fetch from 'node-fetch'
import { SocksProxyAgent } from 'socks-proxy-agent'

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
 * Refresh an existing OAuth credential.
 * grant_type=refresh_token — same as sub2api ClaudeTokenRefresher.
 * Hits api.anthropic.com first (no CF). sessionKey is NOT used here.
 */
export async function refreshOAuthToken(refreshToken, { proxyUrl = null } = {}) {
  const rt = String(refreshToken || '').trim()
  if (!rt) {
    const err = new Error('refresh_token required')
    err.code = 'no_refresh_token'
    throw err
  }
  const prev = _activeProxyUrl
  _activeProxyUrl = proxyUrl || null
  const reqBody = {
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: CLIENT_ID,
  }
  const urls = [
    'https://api.anthropic.com/v1/oauth/token',
    'https://platform.claude.com/v1/oauth/token',
  ]
  let lastErr
  try {
    for (const tokenURL of urls) {
      try {
        const { ok, status, body } = await fetchJson(tokenURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'axios/1.13.6',
          },
          body: JSON.stringify(reqBody),
        })
        if (!ok) {
          const snippet = typeof body === 'string' ? body.slice(0, 240) : JSON.stringify(body || {}).slice(0, 240)
          lastErr = new Error(`token refresh failed @ ${tokenURL}: ${status} ${snippet}`)
          if (status === 400 && /invalid_grant/i.test(snippet)) {
            lastErr.code = 'invalid_grant'
            break
          }
          continue
        }
        if (!body?.access_token) {
          lastErr = new Error(`no access_token in refresh response: ${JSON.stringify(body).slice(0, 240)}`)
          continue
        }
        const expiresIn = Number(body.expires_in || 0)
        const now = Math.floor(Date.now() / 1000)
        return {
          access_token: body.access_token,
          refresh_token: body.refresh_token || rt,
          token_type: body.token_type || 'Bearer',
          expires_in: expiresIn,
          expires_at: now + (expiresIn || 28800),
          scope: body.scope || null,
          source: 'refresh_token',
        }
      } catch (e) {
        lastErr = e
      }
    }
  } finally {
    _activeProxyUrl = prev
  }
  throw lastErr || new Error('token refresh failed on all endpoints')
}

/**
 * Full conversion: sessionKey → OAuth credential object
 */
export async function sessionKeyToOAuth(sessionKey, { scope = 'full', proxyUrl = null } = {}) {
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
    const cred = await sessionKeyToOAuth(sessionKey, { scope })
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
