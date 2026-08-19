/**
 * In-process Anthropic mock for e2e (KIN_CRS_MOCK=1).
 * Never touches the network or credential files.
 */
import fs from 'node:fs'
import path from 'node:path'

export function isCrsMock() {
  return process.env.KIN_CRS_MOCK === '1'
}

export function writeCrsTrace({ body, headers, stream = false }) {
  const dest = process.env.KIN_CRS_TRACE_FILE || process.env.KIN_MOCK_TRACE_FILE
  if (!dest) return
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }) } catch {}
  fs.writeFileSync(dest, JSON.stringify({
    via: 'crs-relay',
    stream: !!stream,
    body,
    headers: redact(headers),
    system: body?.system ?? null,
    thinking: body?.thinking ?? null,
    tools: (body?.tools || []).map((t) => t?.name).filter(Boolean),
    metadata: body?.metadata || null,
  }, null, 2))
}

function redact(h = {}) {
  const out = { ...(h || {}) }
  if (out.authorization) out.authorization = 'Bearer <redacted>'
  delete out['x-api-key']
  return out
}

function message({ text, stop = 'end_turn', content = null }) {
  return {
    type: 'message',
    id: 'msg_crs_mock',
    role: 'assistant',
    model: process.env.KIN_MOCK_MODEL || 'claude-haiku-4-5-20251001',
    content: content || [{ type: 'text', text }],
    stop_reason: stop,
    usage: { input_tokens: 12, output_tokens: 4 },
  }
}

export function mockCrsPayload() {
  const scenario = process.env.KIN_MOCK_SCENARIO || 'text'
  const text = process.env.KIN_MOCK_TEXT || 'pong'
  if (scenario === 'error') {
    return {
      ok: false,
      status: 500,
      via: 'crs-relay',
      transportError: false,
      body: { type: 'error', error: { type: 'api_error', message: 'crs-mock simulated failure' } },
      headers: {},
    }
  }
  if (scenario === 'tool_use') {
    return {
      ok: true,
      status: 200,
      via: 'crs-relay',
      body: message({
        text: '',
        stop: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_mock1', name: 'read_file', input: { path: '/tmp/x' } }],
      }),
      headers: {},
    }
  }
  if (scenario === 'thinking') {
    return {
      ok: true,
      status: 200,
      via: 'crs-relay',
      body: message({
        text: 'thoughtful-pong',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'thoughtful-pong' },
        ],
      }),
      headers: {},
    }
  }
  return {
    ok: true,
    status: 200,
    via: 'crs-relay',
    body: message({ text }),
    headers: { 'anthropic-ratelimit-requests-remaining': '99' },
  }
}

export async function emitMockSse(onEvent, payload) {
  const msg = payload.body
  const lines = []
  const push = (event, data) => {
    lines.push(`event: ${event}`)
    lines.push(`data: ${JSON.stringify(data)}`)
    lines.push('')
  }
  if (payload.ok) {
    push('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null } })
    const blocks = msg.content || []
    blocks.forEach((b, i) => {
      push('content_block_start', { type: 'content_block_start', index: i, content_block: { ...b, text: b.type === 'text' ? '' : b.text } })
      if (b.type === 'text') {
        push('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } })
      }
      push('content_block_stop', { type: 'content_block_stop', index: i })
    })
    push('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason }, usage: msg.usage })
    push('message_stop', { type: 'message_stop' })
  } else {
    push('error', payload.body)
  }
  if (onEvent) {
    for (const line of lines) await onEvent(line)
  }
  return payload
}
