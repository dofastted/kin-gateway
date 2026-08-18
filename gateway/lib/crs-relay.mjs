/**
 * CRS-style official Messages HTTP from the VM UID.
 * Traffic exits via the existing iptables owner-match SOCKS.
 * Reads OAuth from the slot; never writes credential files.
 */
import https from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { resolveCrsHeaders } from './crs-headers.mjs'
import { isCrsMock, writeCrsTrace, mockCrsPayload, emitMockSse } from './crs-mock.mjs'

const ANTHROPIC_HOST = 'api.anthropic.com'
const ANTHROPIC_PATH = '/v1/messages'
const THIS_FILE = fileURLToPath(import.meta.url)
const uidCache = new Map()

export function readSlotAccessToken(exec = {}) {
  const home = exec.homeDir || ''
  for (const name of ['credentials.json', '.credentials.json']) {
    try {
      const p = path.join(home, '.claude', name)
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      const tok = d?.claudeAiOauth?.accessToken || d?.claudeAiOauth?.access_token || ''
      if (tok) return tok
    } catch {}
  }
  return exec.oauth?.access_token || ''
}

export function resolveVmUidGidCached(exec = {}) {
  const id = exec.vmId || exec.vm?.id || 'vm-01'
  if (uidCache.has(id)) return uidCache.get(id)
  const runtimeUser = exec.vm?.runtime?.user
  if (runtimeUser && /^\d+:\d+$/.test(String(runtimeUser))) {
    const [uid, gid] = String(runtimeUser).split(':').map(Number)
    const v = { uid, gid }
    uidCache.set(id, v)
    return v
  }
  const container = exec.vm?.runtime?.container
  if (container) {
    try {
      const out = String(execFileSync('docker', ['inspect', '-f', '{{.Config.User}}', container], {
        encoding: 'utf8',
        timeout: 3000,
      })).trim()
      if (/^\d+/.test(out)) {
        const [u, g] = out.split(':')
        const v = { uid: Number(u) || 10001, gid: Number(g) || 987 }
        uidCache.set(id, v)
        return v
      }
    } catch {}
  }
  const v = { uid: 10001, gid: 987 }
  uidCache.set(id, v)
  return v
}

export function buildCrsRequestHeaders({ reqHeaders, homeDir, accessToken, stream, identity = null }) {
  const picked = resolveCrsHeaders(reqHeaders, homeDir, identity)
  const headers = {
    ...picked,
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  delete headers['accept-encoding']
  delete headers['x-api-key']
  return headers
}

function parseAnthropicJson(buf) {
  try {
    return JSON.parse(String(buf || ''))
  } catch {
    return { type: 'error', error: { type: 'api_error', message: String(buf || '').slice(0, 400) } }
  }
}

export function httpsMessages({ headers, body, timeoutMs, method = 'POST', path = ANTHROPIC_PATH }) {
  return new Promise((resolve, reject) => {
    const verb = String(method || 'POST').toUpperCase()
    const hasBody = body != null && verb !== 'GET' && verb !== 'HEAD'
    const payload = hasBody
      ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      : null
    const hdrs = { ...(headers || {}) }
    if (payload) hdrs['content-length'] = payload.length
    else delete hdrs['content-length']
    const req = https.request({
      hostname: ANTHROPIC_HOST,
      path: path || ANTHROPIC_PATH,
      method: verb,
      headers: hdrs,
      timeout: timeoutMs || 180000,
    }, (res) => {
      resolve({ status: res.statusCode || 0, headers: res.headers, stream: res })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function readAll(stream) {
  const chunks = []
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

async function runWorker() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const { status, headers, stream } = await httpsMessages(spec)
  process.stdout.write(`HTTP ${status}\n`)
  for (const [k, v] of Object.entries(headers || {})) {
    const val = Array.isArray(v) ? v.join(',') : String(v)
    process.stdout.write(`${k}: ${val}\n`)
  }
  process.stdout.write('\n')
  stream.pipe(process.stdout)
}

function spawnUidWorker({ uid, gid, spec }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [THIS_FILE], {
      uid,
      gid,
      env: { ...process.env, KIN_CRS_WORKER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.stdin.write(JSON.stringify(spec))
    child.stdin.end()

    let headerBuf = Buffer.alloc(0)
    let resolved = false
    const tryParse = () => {
      const idx = headerBuf.indexOf('\n\n')
      if (idx < 0 || resolved) return
      const head = headerBuf.slice(0, idx).toString('utf8')
      const rest = headerBuf.slice(idx + 2)
      const lines = head.split('\n')
      const m = /^HTTP\s+(\d+)/.exec(lines[0] || '')
      const status = m ? Number(m[1]) : 0
      const headers = {}
      for (const line of lines.slice(1)) {
        const c = line.indexOf(':')
        if (c < 0) continue
        headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim()
      }
      resolved = true
      child.stdout.off('data', onData)
      const combined = rest.length
        ? Readable.from((async function* () {
            yield rest
            for await (const c of child.stdout) yield c
          })())
        : child.stdout
      resolve({ status, headers, stream: combined, child, stderr: () => err })
    }
    const onData = (chunk) => {
      headerBuf = Buffer.concat([headerBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      tryParse()
    }
    child.stdout.on('data', onData)
    child.on('close', (code) => {
      if (!resolved) reject(new Error(`crs-worker exit ${code}: ${err.slice(0, 300)}`))
    })
  })
}

/** Generic Anthropic HTTPS from the VM UID (GET usage / POST messages). */
export async function callVmHttps({
  exec,
  method = 'POST',
  path = ANTHROPIC_PATH,
  body = null,
  reqHeaders = {},
  timeoutMs = 20000,
  identity = null,
  accept = 'application/json',
}) {
  const accessToken = readSlotAccessToken(exec)
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      via: 'crs-uid',
      transportError: false,
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
      headers: {},
    }
  }
  const { uid, gid } = resolveVmUidGidCached(exec)
  const headers = buildCrsRequestHeaders({
    reqHeaders,
    homeDir: exec?.homeDir,
    accessToken,
    stream: false,
    identity,
  })
  headers.accept = accept
  try {
    const worker = await spawnUidWorker({
      uid,
      gid,
      spec: { headers, body, timeoutMs, method, path },
    })
    const buf = await readAll(worker.stream)
    const parsed = parseAnthropicJson(buf)
    return {
      ok: worker.status >= 200 && worker.status < 300,
      status: worker.status,
      via: 'crs-uid',
      body: parsed,
      headers: worker.headers,
      transportError: false,
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      via: 'crs-uid',
      transportError: true,
      body: { type: 'error', error: { type: 'api_error', message: String(e.message || e).slice(0, 300) } },
      headers: {},
    }
  }
}

export async function callCrsRelay({ exec, body, reqHeaders, timeoutMs, identity = null }) {
  if (isCrsMock()) {
    const headers = buildCrsRequestHeaders({
      reqHeaders,
      homeDir: exec?.homeDir,
      accessToken: readSlotAccessToken(exec) || 'sk-ant-oat01-MOCK',
      stream: false,
      identity,
    })
    writeCrsTrace({ body, headers, stream: false })
    return mockCrsPayload()
  }
  const accessToken = readSlotAccessToken(exec)
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      via: 'crs-relay',
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
      headers: {},
    }
  }
  const { uid, gid } = resolveVmUidGidCached(exec)
  const headers = buildCrsRequestHeaders({
    reqHeaders,
    homeDir: exec.homeDir,
    accessToken,
    stream: false,
    identity,
  })
  try {
    const worker = await spawnUidWorker({
      uid,
      gid,
      spec: { headers, body, timeoutMs: timeoutMs || 180000 },
    })
    const buf = await readAll(worker.stream)
    const parsed = parseAnthropicJson(buf)
    const ok = worker.status === 200 && parsed?.type !== 'error'
    return {
      ok,
      status: worker.status,
      via: 'crs-relay',
      body: parsed,
      headers: worker.headers,
      transportError: false,
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      via: 'crs-relay',
      transportError: true,
      body: { type: 'error', error: { type: 'api_error', message: String(e.message || e).slice(0, 300) } },
      headers: {},
    }
  }
}

export async function streamCrsRelay({ exec, body, reqHeaders, timeoutMs, onEvent, identity = null }) {
  if (isCrsMock()) {
    const headers = buildCrsRequestHeaders({
      reqHeaders,
      homeDir: exec?.homeDir,
      accessToken: readSlotAccessToken(exec) || 'sk-ant-oat01-MOCK',
      stream: true,
      identity,
    })
    writeCrsTrace({ body, headers, stream: true })
    const payload = mockCrsPayload()
    payload.via = 'crs-relay-stream'
    await emitMockSse(onEvent, payload)
    return payload
  }
  const accessToken = readSlotAccessToken(exec)
  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      via: 'crs-relay-stream',
      body: { type: 'error', error: { type: 'authentication_error', message: 'VM has no OAuth access_token' } },
      headers: {},
    }
  }
  const { uid, gid } = resolveVmUidGidCached(exec)
  const headers = buildCrsRequestHeaders({
    reqHeaders,
    homeDir: exec.homeDir,
    accessToken,
    stream: true,
    identity,
  })
  try {
    const worker = await spawnUidWorker({
      uid,
      gid,
      spec: { headers, body, timeoutMs: timeoutMs || 180000 },
    })
    let buf = ''
    let lastError = null
    for await (const chunk of worker.stream) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (onEvent) await onEvent(line)
        if (line.startsWith('data:')) {
          try {
            const obj = JSON.parse(line.slice(5).trim())
            if (obj?.type === 'error') lastError = obj
          } catch {}
        }
      }
    }
    if (buf && onEvent) await onEvent(buf)
    const ok = worker.status === 200 && !lastError
    return {
      ok,
      status: worker.status || (lastError ? 400 : 0),
      via: 'crs-relay-stream',
      body: lastError || { type: 'message', role: 'assistant', content: [] },
      headers: worker.headers,
      transportError: false,
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      via: 'crs-relay-stream',
      transportError: true,
      body: { type: 'error', error: { type: 'api_error', message: String(e.message || e).slice(0, 300) } },
      headers: {},
    }
  }
}

if (process.env.KIN_CRS_WORKER === '1') {
  runWorker().catch((e) => {
    process.stderr.write(String(e && e.stack || e) + '\n')
    process.exit(1)
  })
}
