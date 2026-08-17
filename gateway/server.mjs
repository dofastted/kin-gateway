/**
 * DISABLED — legacy direct-Anthropic gateway.
 * Production entrypoint is server-v2.mjs (VM Claude Code only).
 */
throw new Error('DISABLED: use server-v2.mjs. Direct Anthropic HTTP proxy is not allowed.')

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT || 8787)
const API_KEY = process.env.KIN_API_KEY || 'sk-kin-' + crypto.randomBytes(16).toString('hex')

// --- load VM OAuth credential ---
const active = JSON.parse(fs.readFileSync(path.join(ROOT, 'vms', 'active.json'), 'utf8'))
const vm = JSON.parse(fs.readFileSync(path.join(ROOT, 'vms', `${active.active_vm}.json`), 'utf8'))
const OAUTH = {
  access_token: vm.claude.access_token,
  refresh_token: vm.claude.refresh_token,
  expires_at: vm.claude.expires_at,
  email: vm.claude.email,
  org_uuid: vm.claude.org_uuid,
  vm_id: vm.id,
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// persist gateway config for clients
const gatewayMeta = {
  base_url: `http://127.0.0.1:${PORT}`,
  api_key: API_KEY,
  vm_id: vm.id,
  email: OAUTH.email,
  endpoints: {
    models: '/v1/models',
    chat_completions: '/v1/chat/completions',
    responses: '/v1/responses',
    messages: '/v1/messages',
  },
  created_at: new Date().toISOString(),
}
fs.writeFileSync(path.join(__dirname, 'gateway.json'), JSON.stringify(gatewayMeta, null, 2), { mode: 0o600 })
fs.writeFileSync(path.join(__dirname, 'gateway.public.json'), JSON.stringify({
  ...gatewayMeta,
  api_key: API_KEY.slice(0, 10) + '…' + API_KEY.slice(-6),
}, null, 2))

// ---------- helpers ----------
function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('invalid json body')) }
    })
    req.on('error', reject)
  })
}

function extractApiKey(req) {
  const h = req.headers
  const auth = h.authorization || h.Authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  if (h['x-api-key']) return String(h['x-api-key']).trim()
  return ''
}

function requireAuth(req, res) {
  const key = extractApiKey(req)
  if (!key || key !== API_KEY) {
    json(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error' } })
    return false
  }
  return true
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.type === 'text') return p.text || ''
        if (p?.type === 'input_text') return p.text || ''
        if (p?.type === 'output_text') return p.text || ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object' && content.text) return content.text
  return ''
}

/** OpenAI chat messages → Claude messages + system */
function openaiToClaude(body) {
  const model = mapModel(body.model)
  const systemParts = []
  const messages = []
  for (const m of body.messages || []) {
    const text = contentToText(m.content)
    if (m.role === 'system' || m.role === 'developer') {
      if (text) systemParts.push(text)
      continue
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    // merge consecutive same-role
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += '\n' + text
    } else {
      messages.push({ role, content: text })
    }
  }
  // Claude requires alternating; ensure starts with user
  if (messages.length && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(continue)' })
  }
  const out = {
    model,
    max_tokens: body.max_tokens || body.max_completion_tokens || 1024,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  if (body.temperature != null) out.temperature = body.temperature
  return out
}

/** OpenAI Responses API → Claude */
function responsesToClaude(body) {
  const model = mapModel(body.model)
  const systemParts = []
  const messages = []

  if (body.instructions) systemParts.push(String(body.instructions))

  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item })
        continue
      }
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user'
      const text = contentToText(item.content ?? item.text ?? item)
      if (role === 'system') {
        if (text) systemParts.push(text)
      } else if (messages.length && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += '\n' + text
      } else {
        messages.push({ role, content: text })
      }
    }
  }

  if (!messages.length) messages.push({ role: 'user', content: 'hello' })
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(continue)' })

  const out = {
    model,
    max_tokens: body.max_output_tokens || body.max_tokens || 1024,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  return out
}

/** Anthropic messages body — pass through with model map */
function passthroughClaude(body) {
  return {
    ...body,
    model: mapModel(body.model || DEFAULT_MODEL),
    max_tokens: body.max_tokens || 1024,
  }
}

function mapModel(m) {
  if (!m) return DEFAULT_MODEL
  const s = String(m)
  // allow already-claude ids
  if (s.startsWith('claude-')) return s
  // common OpenAI aliases → Claude
  if (/gpt-4o-mini|o1-mini|o3-mini|haiku/i.test(s)) return 'claude-haiku-4-5-20251001'
  if (/gpt-4o|gpt-4\.1|gpt-4|o1|o3|sonnet/i.test(s)) return 'claude-sonnet-4-6'
  if (/opus|gpt-5/i.test(s)) return 'claude-opus-4-6'
  return DEFAULT_MODEL
}

async function callClaude(claudeBody) {
  // force non-stream for gateway simplicity; clients can still send stream:true (we buffer)
  const payload = { ...claudeBody, stream: false }
  delete payload.stream

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      authorization: `Bearer ${OAUTH.access_token}`,
      'x-app': 'cli',
      'user-agent': 'claude-cli/2.1.161 (external, cli)',
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: res.status, body, headers: res.headers }
}

function claudeToOpenAIChat(claude, requestedModel) {
  const text = (claude.content || []).map((b) => b.text || '').join('')
  const id = 'chatcmpl-' + (claude.id || crypto.randomBytes(8).toString('hex'))
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || claude.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: claude.stop_reason === 'end_turn' ? 'stop' : (claude.stop_reason || 'stop'),
    }],
    usage: {
      prompt_tokens: claude.usage?.input_tokens || 0,
      completion_tokens: claude.usage?.output_tokens || 0,
      total_tokens: (claude.usage?.input_tokens || 0) + (claude.usage?.output_tokens || 0),
    },
    // kin metadata
    kin: { vm_id: OAUTH.vm_id, upstream_model: claude.model },
  }
}

function claudeToResponses(claude, requestedModel) {
  const text = (claude.content || []).map((b) => b.text || '').join('')
  const id = 'resp_' + crypto.randomBytes(8).toString('hex')
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestedModel || claude.model,
    output: [{
      type: 'message',
      id: 'msg_' + crypto.randomBytes(4).toString('hex'),
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    output_text: text,
    usage: {
      input_tokens: claude.usage?.input_tokens || 0,
      output_tokens: claude.usage?.output_tokens || 0,
      total_tokens: (claude.usage?.input_tokens || 0) + (claude.usage?.output_tokens || 0),
    },
    kin: { vm_id: OAUTH.vm_id, upstream_model: claude.model },
  }
}

// ---------- server ----------
const stats = { requests: 0, by_route: {} }

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-session-id',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      })
      return res.end()
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const p = url.pathname

    if (req.method === 'GET' && (p === '/' || p === '/health')) {
      return json(res, 200, {
        status: 'ok',
        service: 'kin-gateway',
        vm_id: OAUTH.vm_id,
        email: OAUTH.email,
        base_url: gatewayMeta.base_url,
        stats,
      })
    }

    if (req.method === 'GET' && p === '/v1/models') {
      if (!requireAuth(req, res)) return
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'claude-haiku-4-5-20251001', object: 'model', owned_by: 'kin' },
          { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'kin' },
          { id: 'claude-opus-4-6', object: 'model', owned_by: 'kin' },
          { id: 'gpt-4o', object: 'model', owned_by: 'kin-alias' },
          { id: 'gpt-4o-mini', object: 'model', owned_by: 'kin-alias' },
        ],
      })
    }

    // --- protocol routes ---
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req)
      stats.requests++
      stats.by_route['chat.completions'] = (stats.by_route['chat.completions'] || 0) + 1
      const claudeReq = openaiToClaude(body)
      const upstream = await callClaude(claudeReq)
      if (upstream.status !== 200) {
        return json(res, upstream.status, {
          error: { message: upstream.body?.error?.message || 'upstream error', type: upstream.body?.error?.type || 'api_error', upstream: upstream.body },
        })
      }
      return json(res, 200, claudeToOpenAIChat(upstream.body, body.model))
    }

    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req)
      stats.requests++
      stats.by_route['responses'] = (stats.by_route['responses'] || 0) + 1
      const claudeReq = responsesToClaude(body)
      const upstream = await callClaude(claudeReq)
      if (upstream.status !== 200) {
        return json(res, upstream.status, {
          error: { message: upstream.body?.error?.message || 'upstream error', type: upstream.body?.error?.type || 'api_error', upstream: upstream.body },
        })
      }
      return json(res, 200, claudeToResponses(upstream.body, body.model))
    }

    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req)
      stats.requests++
      stats.by_route['messages'] = (stats.by_route['messages'] || 0) + 1
      const claudeReq = passthroughClaude(body)
      const upstream = await callClaude(claudeReq)
      if (upstream.status !== 200) {
        return json(res, upstream.status, upstream.body)
      }
      // attach kin meta without breaking anthropic shape
      const out = { ...upstream.body, kin: { vm_id: OAUTH.vm_id } }
      return json(res, 200, out)
    }

    json(res, 404, { error: { message: `not found: ${p}`, type: 'not_found' } })
  } catch (e) {
    json(res, 500, { error: { message: e.message || String(e), type: 'server_error' } })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'kin-gateway-started',
    base_url: gatewayMeta.base_url,
    api_key: API_KEY,
    vm_id: OAUTH.vm_id,
    email: OAUTH.email,
  }, null, 2))
})
