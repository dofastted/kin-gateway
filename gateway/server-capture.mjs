/**
 * DISABLED — legacy capture gateway that hit Anthropic HTTP directly.
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
const API_KEY = process.env.KIN_API_KEY || 'sk-kin-test-protocol-bridge-001'
const CAPTURE_DIR = path.join(__dirname, 'captures')
fs.mkdirSync(CAPTURE_DIR, { recursive: true })

const active = JSON.parse(fs.readFileSync(path.join(ROOT, 'vms', 'active.json'), 'utf8'))
const vm = JSON.parse(fs.readFileSync(path.join(ROOT, 'vms', `${active.active_vm}.json`), 'utf8'))
const OAUTH = {
  access_token: vm.claude.access_token,
  email: vm.claude.email,
  org_uuid: vm.claude.org_uuid,
  vm_id: vm.id,
}
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

const captures = []
function capturePacket(entry) {
  const rec = {
    seq: captures.length + 1,
    ts: new Date().toISOString(),
    ...entry,
  }
  // strip secrets from stored headers for report
  const safe = JSON.parse(JSON.stringify(rec))
  if (safe.upstream_headers?.authorization) {
    safe.upstream_headers.authorization = 'Bearer sk-ant-oat01-***REDACTED***'
  }
  captures.push(safe)
  const file = path.join(CAPTURE_DIR, `pkt-${String(safe.seq).padStart(3, '0')}-${safe.inbound_protocol}.json`)
  fs.writeFileSync(file, JSON.stringify(safe, null, 2))
  fs.writeFileSync(path.join(CAPTURE_DIR, 'latest.json'), JSON.stringify(captures, null, 2))
  console.log(`[CAPTURE #${safe.seq}] ${safe.inbound_protocol} → ${safe.upstream_method} ${safe.upstream_url}`)
  return safe
}

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
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

function extractApiKey(req) {
  const auth = req.headers.authorization || ''
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim()
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
    return content.map((p) => {
      if (typeof p === 'string') return p
      if (p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text') return p.text || ''
      return ''
    }).filter(Boolean).join('\n')
  }
  if (content?.text) return content.text
  return ''
}

function mapModel(m) {
  if (!m) return DEFAULT_MODEL
  const s = String(m)
  if (s.startsWith('claude-')) return s
  if (/gpt-4o-mini|o1-mini|o3-mini|haiku/i.test(s)) return 'claude-haiku-4-5-20251001'
  if (/gpt-4o|gpt-4\.1|gpt-4|o1|o3|sonnet/i.test(s)) return 'claude-sonnet-4-6'
  if (/opus|gpt-5/i.test(s)) return 'claude-opus-4-6'
  return DEFAULT_MODEL
}

function openaiToClaude(body) {
  const systemParts = []
  const messages = []
  for (const m of body.messages || []) {
    const text = contentToText(m.content)
    if (m.role === 'system' || m.role === 'developer') {
      if (text) systemParts.push(text)
      continue
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += '\n' + text
    } else {
      messages.push({ role, content: text })
    }
  }
  if (messages.length && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(continue)' })
  }
  const out = {
    model: mapModel(body.model),
    max_tokens: body.max_tokens || body.max_completion_tokens || 1024,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  if (body.temperature != null) out.temperature = body.temperature
  return out
}

function responsesToClaude(body) {
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
    model: mapModel(body.model),
    max_tokens: body.max_output_tokens || body.max_tokens || 1024,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join('\n\n')
  return out
}

function passthroughClaude(body) {
  return {
    model: mapModel(body.model || DEFAULT_MODEL),
    max_tokens: body.max_tokens || 1024,
    messages: body.messages,
    ...(body.system ? { system: body.system } : {}),
  }
}

function isUnifiedClaudeMessages(payload) {
  return (
    payload &&
    typeof payload === 'object' &&
    typeof payload.model === 'string' &&
    payload.model.startsWith('claude-') &&
    typeof payload.max_tokens === 'number' &&
    Array.isArray(payload.messages) &&
    payload.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  )
}

async function callClaude(claudeBody, meta) {
  const payload = { ...claudeBody, stream: false }
  delete payload.stream

  const upstreamUrl = 'https://api.anthropic.com/v1/messages'
  const upstreamHeaders = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    authorization: `Bearer ${OAUTH.access_token}`,
    'x-app': 'cli',
    'user-agent': 'claude-cli/2.1.161 (external, cli)',
  }

  const pkt = capturePacket({
    vm_id: OAUTH.vm_id,
    inbound_protocol: meta.protocol,
    inbound_path: meta.path,
    inbound_body: meta.inbound,
    upstream_method: 'POST',
    upstream_url: upstreamUrl,
    upstream_headers: { ...upstreamHeaders },
    upstream_body: payload,
    unified_claude_messages: isUnifiedClaudeMessages(payload),
    schema_check: {
      has_model: typeof payload.model === 'string',
      model_is_claude: String(payload.model || '').startsWith('claude-'),
      has_max_tokens: typeof payload.max_tokens === 'number',
      has_messages_array: Array.isArray(payload.messages),
      roles_valid: Array.isArray(payload.messages) && payload.messages.every((m) => ['user', 'assistant'].includes(m?.role)),
      no_openai_messages_shape: !('choices' in payload),
      no_responses_input_field: !('input' in payload),
      no_stream_true: payload.stream !== true,
    },
  })

  const res = await fetch(upstreamUrl, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }

  // update capture with response status
  pkt.upstream_status = res.status
  pkt.upstream_response_preview = body?.content
    ? body.content.map((c) => c.text || '').join('').slice(0, 120)
    : (body?.error?.type || body?.error?.message || JSON.stringify(body).slice(0, 120))
  fs.writeFileSync(
    path.join(CAPTURE_DIR, `pkt-${String(pkt.seq).padStart(3, '0')}-${pkt.inbound_protocol}.json`),
    JSON.stringify(pkt, null, 2),
  )
  fs.writeFileSync(path.join(CAPTURE_DIR, 'latest.json'), JSON.stringify(captures, null, 2))

  return { status: res.status, body }
}

function claudeToOpenAIChat(claude, requestedModel) {
  const text = (claude.content || []).map((b) => b.text || '').join('')
  return {
    id: 'chatcmpl-' + (claude.id || crypto.randomBytes(8).toString('hex')),
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
    kin: { vm_id: OAUTH.vm_id, upstream_model: claude.model },
  }
}

function claudeToResponses(claude, requestedModel) {
  const text = (claude.content || []).map((b) => b.text || '').join('')
  return {
    id: 'resp_' + crypto.randomBytes(8).toString('hex'),
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
        service: 'kin-gateway-capture',
        vm_id: OAUTH.vm_id,
        captures: captures.length,
        base_url: `http://127.0.0.1:${PORT}`,
      })
    }

    if (req.method === 'GET' && p === '/captures') {
      if (!requireAuth(req, res)) return
      return json(res, 200, { count: captures.length, packets: captures })
    }

    if (req.method === 'GET' && p === '/v1/models') {
      if (!requireAuth(req, res)) return
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'claude-haiku-4-5-20251001', object: 'model' },
          { id: 'gpt-4o', object: 'model' },
          { id: 'gpt-4o-mini', object: 'model' },
        ],
      })
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req)
      const claudeReq = openaiToClaude(body)
      const upstream = await callClaude(claudeReq, { protocol: 'openai.chat.completions', path: p, inbound: body })
      if (upstream.status !== 200) return json(res, upstream.status, { error: upstream.body?.error || upstream.body })
      return json(res, 200, claudeToOpenAIChat(upstream.body, body.model))
    }

    if (req.method === 'POST' && (p === '/v1/responses' || p === '/responses')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req)
      const claudeReq = responsesToClaude(body)
      const upstream = await callClaude(claudeReq, { protocol: 'openai.responses', path: p, inbound: body })
      if (upstream.status !== 200) return json(res, upstream.status, { error: upstream.body?.error || upstream.body })
      return json(res, 200, claudeToResponses(upstream.body, body.model))
    }

    if (req.method === 'POST' && (p === '/v1/messages' || p === '/messages')) {
      if (!requireAuth(req, res)) return
      const body = await readBody(req)
      const claudeReq = passthroughClaude(body)
      const upstream = await callClaude(claudeReq, { protocol: 'anthropic.messages', path: p, inbound: body })
      if (upstream.status !== 200) return json(res, upstream.status, upstream.body)
      return json(res, 200, { ...upstream.body, kin: { vm_id: OAUTH.vm_id } })
    }

    json(res, 404, { error: { message: `not found: ${p}` } })
  } catch (e) {
    json(res, 500, { error: { message: e.message } })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'kin-gateway-capture-started',
    base_url: `http://127.0.0.1:${PORT}`,
    api_key: API_KEY,
    vm_id: OAUTH.vm_id,
    capture_dir: CAPTURE_DIR,
  }, null, 2))
})
