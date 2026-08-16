/** Upstream Claude calls — capture unified rate-limit headers */

const DEFAULT_HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
  'x-app': 'cli',
  'user-agent': 'claude-cli/2.1.233 (external, sdk-cli)',
}

function headersToObject(h) {
  const o = {}
  if (!h) return o
  if (typeof h.forEach === 'function') {
    h.forEach((v, k) => {
      o[String(k).toLowerCase()] = v
    })
  } else {
    for (const [k, v] of Object.entries(h)) o[String(k).toLowerCase()] = v
  }
  return o
}

export async function callClaudeUpstream({ token, body, timeoutMs = 120000, headers }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const h = {
      ...(headers || DEFAULT_HEADERS),
      authorization: `Bearer ${token}`,
    }
    if (!h['content-type']) h['content-type'] = 'application/json'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: h,
      body: JSON.stringify({ ...body, stream: false }),
    })
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
    return {
      status: res.status,
      body: parsed,
      headers: headersToObject(res.headers),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function streamClaudeUpstream({ token, body, timeoutMs = 120000, headers, onEvent, onHeaders }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const h = {
      ...(headers || DEFAULT_HEADERS),
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
    }
    if (!h['content-type']) h['content-type'] = 'application/json'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: h,
      body: JSON.stringify({ ...body, stream: true }),
    })

    const respHeaders = headersToObject(res.headers)
    if (typeof onHeaders === 'function') {
      try {
        onHeaders(respHeaders)
      } catch {}
    }

    if (!res.ok || !res.body) {
      const text = await res.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text }
      }
      return { status: res.status, body: parsed, headers: respHeaders, ok: false }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const line of parts) {
        const trimmed = line.replace(/\r$/, '')
        if (trimmed.startsWith('data:')) {
          await onEvent(trimmed)
        }
      }
    }
    if (buf.trim().startsWith('data:')) await onEvent(buf.trim())
    return { status: 200, ok: true, headers: respHeaders }
  } finally {
    clearTimeout(timer)
  }
}
