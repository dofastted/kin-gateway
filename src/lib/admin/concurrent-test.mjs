/**
 * Concurrent persistent-conversation load test.
 *
 * Simulates N real unofficial /v1/messages clients (sticky x-session-id,
 * stream, adaptive thinking, no anthropic-beta so stored Claude Code betas
 * replay). Each session asks for ONE stock research report, then a follow-up
 * on the same ticker — never mixing names in a single prompt.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getCapabilities } from '../protocol/model-policy.mjs'

export const DEFAULT_STOCKS = [
  { ticker: 'TSLA', name: 'Tesla' },
  { ticker: 'AAPL', name: 'Apple' },
  { ticker: 'GOOGL', name: 'Alphabet / Google' },
  { ticker: 'AMZN', name: 'Amazon / AWS' },
  { ticker: 'SNDK', name: 'Sandisk' },
]

export const DEFAULT_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
]

const TEST_UA = 'kin-console-loadtest/1.0'
const MAX_RUNS = 8
export const REPORTS_PUBLIC_ROOT = '/opt/kin-gateway/data/loadtests/reports'
/** Stagger session starts so N-way loadtests do not slam the pool at t=0. */
export const SESSION_START_STAGGER_MS = 500
/** Adaptive thinking + output share this cap. Do not silently shrink a user value. */
export const DEFAULT_THINKING_BUDGET = 32000
const ABSOLUTE_MAX_TOKENS = 128000
const runs = new Map()
let activeId = null

function nowIso() {
  return new Date().toISOString()
}

function resolveMaxTokens(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_THINKING_BUDGET
  return Math.min(Math.max(1, Math.floor(n)), ABSOLUTE_MAX_TOKENS)
}

function clip(s, n = 400) {
  const t = String(s || '')
  return t.length <= n ? t : t.slice(0, n) + '…'
}

function normalizeStocks(input) {
  if (!Array.isArray(input) || !input.length) return DEFAULT_STOCKS.map((s) => ({ ...s }))
  const byTicker = new Map(DEFAULT_STOCKS.map((s) => [s.ticker, s]))
  const out = []
  for (const raw of input) {
    if (typeof raw === 'string') {
      const ticker = raw.trim().toUpperCase()
      const hit = byTicker.get(ticker) || DEFAULT_STOCKS.find((s) => s.name.toUpperCase().includes(ticker))
      out.push(hit ? { ...hit } : { ticker, name: ticker })
      continue
    }
    if (raw && typeof raw === 'object') {
      const ticker = String(raw.ticker || raw.symbol || '').trim().toUpperCase()
      if (!ticker) continue
      const hit = byTicker.get(ticker)
      out.push({ ticker, name: String(raw.name || hit?.name || ticker) })
    }
  }
  return out.length ? out : DEFAULT_STOCKS.map((s) => ({ ...s }))
}

function normalizeModels(input) {
  const allowed = new Set(DEFAULT_MODELS)
  const list = (Array.isArray(input) && input.length ? input : DEFAULT_MODELS)
    .map((id) => String(id || '').trim())
    .filter((id) => allowed.has(id) || /^claude-(opus|sonnet|fable)-5/.test(id) || /haiku/i.test(id))
  return list.length ? [...new Set(list)] : [...DEFAULT_MODELS]
}

export function shanghaiDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function reportsRoot(dataDir) {
  return path.join(dataDir || '', 'loadtests', 'reports')
}

export function safeReportPart(s, fallback = 'x') {
  const t = String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return (t || fallback).slice(0, 80)
}

export function turnFileName(session, n) {
  return `${String((session?.index ?? 0) + 1).padStart(2, '0')}-${safeReportPart(session?.stock?.ticker, 'TICK')}-${safeReportPart(session?.model, 'model')}-t${n}.md`
}

export function promptWritePath(day, session, n) {
  return `${REPORTS_PUBLIC_ROOT}/${day}/${turnFileName(session, n)}`
}

export function ensureReportsDir(dataDir, day) {
  const dir = path.join(reportsRoot(dataDir), day)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeInstruction(destPath) {
  if (!destPath) return []
  return [
    `- 将完整 Markdown 正文写入文件：${destPath}`,
    '- 只输出将写入该文件的正文，不要解释写文件过程',
  ]
}

export function buildReportPrompt(stock, destPath) {
  return [
    `请撰写一份关于「${stock.name}」（股票代码 ${stock.ticker}）的投资研报。`,
    '硬性要求：',
    `- 只分析 ${stock.ticker} 这一只标的，不要提及、对比或推荐其他股票`,
    '- 使用中文，结构清晰，观点明确，不要空泛',
    '- 必须包含：投资摘要、业务与竞争格局、财务与估值、近况与催化剂、主要风险、结论',
    ...writeInstruction(destPath),
  ].join('\n')
}

export function buildFollowupPrompt(stock, turn, destPath) {
  if (turn === 2) {
    return [
      `基于上文对 ${stock.ticker} 的研报，继续同一标的（不要切换到其他股票）：`,
      '1. 给出明确评级：买入 / 持有 / 卖出',
      '2. 给出 12 个月目标价（美元）及估值依据',
      '3. 列出你最看重的 3 个跟踪变量',
      ...writeInstruction(destPath),
    ].join('\n')
  }
  return [
    `仍只讨论 ${stock.ticker}。如果未来 30 天出现显著利空，你会如何修正评级与目标价？用三条情景说明。不要切换到其他股票。`,
    ...writeInstruction(destPath),
  ].join('\n')
}

function publicSession(session, { includeText = false } = {}) {
  return {
    id: session.id,
    index: session.index,
    ticker: session.stock.ticker,
    name: session.stock.name,
    model: session.model,
    status: session.status,
    turn: session.turn,
    turns_done: session.turns.filter((t) => t.finished).length,
    turns_planned: session.plannedTurns,
    duration_ms: session.duration_ms,
    error: session.error,
    turns: session.turns.map((t) => ({
      n: t.n,
      ok: t.ok,
      status: t.status,
      duration_ms: t.duration_ms,
      ttft_ms: t.ttft_ms,
      chars: t.chars,
      stop_reason: t.stop_reason,
      usage: t.usage,
      preview: t.preview,
      error: t.error,
      saved_path: t.saved_path || null,
      text: includeText ? t.text : undefined,
    })),
  }
}

function summarizeRun(run) {
  const sessions = run.sessions
  const finished = sessions.filter((s) => s.status === 'ok' || s.status === 'error' || s.status === 'cancelled')
  const ok = sessions.filter((s) => s.status === 'ok')
  const durations = ok.map((s) => s.duration_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  const ttfts = []
  let tokensIn = 0
  let tokensOut = 0
  for (const s of sessions) {
    for (const t of s.turns) {
      if (t.ttft_ms != null) ttfts.push(t.ttft_ms)
      tokensIn += Number(t.usage?.input_tokens) || 0
      tokensOut += Number(t.usage?.output_tokens) || 0
    }
  }
  ttfts.sort((a, b) => a - b)
  const pct = (arr, p) => {
    if (!arr.length) return null
    const i = Math.min(arr.length - 1, Math.max(0, Math.ceil(arr.length * p) - 1))
    return arr[i]
  }
  const byModel = {}
  const byTicker = {}
  for (const s of sessions) {
    const bucket = (map, key) => {
      map[key] = map[key] || { total: 0, ok: 0, error: 0 }
      map[key].total++
      if (s.status === 'ok') map[key].ok++
      if (s.status === 'error') map[key].error++
    }
    bucket(byModel, s.model)
    bucket(byTicker, s.stock.ticker)
  }
  return {
    total: sessions.length,
    finished: finished.length,
    ok: ok.length,
    error: sessions.filter((s) => s.status === 'error').length,
    cancelled: sessions.filter((s) => s.status === 'cancelled').length,
    running: sessions.filter((s) => s.status === 'running' || s.status === 'pending').length,
    success_rate: sessions.length ? +(ok.length / sessions.length).toFixed(3) : 0,
    duration_ms: {
      avg: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      p50: pct(durations, 0.5),
      p95: pct(durations, 0.95),
      max: durations.length ? durations[durations.length - 1] : null,
    },
    ttft_ms: {
      avg: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      p50: pct(ttfts, 0.5),
      p95: pct(ttfts, 0.95),
    },
    tokens: { input: tokensIn, output: tokensOut },
    by_model: byModel,
    by_ticker: byTicker,
  }
}

function renderMarkdown(run) {
  const sum = summarizeRun(run)
  const lines = []
  lines.push(`# KIN 并发对话压测研报`)
  lines.push('')
  lines.push(`- 时间：${run.started_at} → ${run.finished_at || '进行中'}`)
  lines.push(`- 场景：${run.concurrency} 并发持续性对话 · 每会话 ${run.turns} 轮 · 每问一只股票研报`)
  lines.push(`- 模型：${run.models.join(', ')}`)
  lines.push(`- 标的：${run.stocks.map((s) => s.ticker).join(', ')}`)
  lines.push(`- 结果：${sum.ok}/${sum.total} 成功（${Math.round(sum.success_rate * 100)}%） 失败 ${sum.error} 取消 ${sum.cancelled}`)
  lines.push(`- 会话耗时 p50/p95/max：${sum.duration_ms.p50 ?? '—'} / ${sum.duration_ms.p95 ?? '—'} / ${sum.duration_ms.max ?? '—'} ms`)
  lines.push(`- 首 token p50/p95：${sum.ttft_ms.p50 ?? '—'} / ${sum.ttft_ms.p95 ?? '—'} ms`)
  lines.push(`- tokens in/out：${sum.tokens.input} / ${sum.tokens.output}`)
  lines.push('')
  lines.push('## 分模型')
  lines.push('| 模型 | 成功 | 失败 | 合计 |')
  lines.push('|---|---:|---:|---:|')
  for (const [model, b] of Object.entries(sum.by_model)) {
    lines.push(`| ${model} | ${b.ok} | ${b.error} | ${b.total} |`)
  }
  lines.push('')
  lines.push('## 分标的')
  lines.push('| 标的 | 成功 | 失败 | 合计 |')
  lines.push('|---|---:|---:|---:|')
  for (const [ticker, b] of Object.entries(sum.by_ticker)) {
    lines.push(`| ${ticker} | ${b.ok} | ${b.error} | ${b.total} |`)
  }
  lines.push('')
  lines.push('## 会话明细')
  lines.push('| # | 模型 | 标的 | 状态 | 耗时 | 轮次 | 预览 |')
  lines.push('|---|---|---|---|---:|---:|---|')
  for (const s of run.sessions) {
    const preview = s.turns[0]?.preview || s.error || ''
    lines.push(`| ${s.index + 1} | ${s.model} | ${s.stock.ticker} | ${s.status} | ${s.duration_ms || '—'} | ${s.turns.filter((t) => t.finished).length}/${s.plannedTurns} | ${String(preview).replace(/\|/g, '/').slice(0, 80)} |`)
  }
  lines.push('')
  if (run.error) {
    lines.push(`## 全局错误`)
    lines.push(run.error)
    lines.push('')
  }
  lines.push('## 结论')
  if (sum.error === 0 && sum.ok === sum.total && sum.total) {
    lines.push('10 路粘性多轮对话全部跑通，单凭证槽在当前并发下可承载该工作负载。')
  } else if (sum.ok === 0) {
    lines.push('全部失败，优先核对槽位 JSON 是否软暂停、账号额度、429 extra-usage 与 worker/SOCKS 出站。')
  } else {
    lines.push(`部分失败（${sum.error}/${sum.total}）。按模型/标的表定位是否集中在某一模型或第 2 轮粘性。`)
  }
  lines.push('')
  return lines.join('\n')
}

function publicRun(run, { includeText = false } = {}) {
  if (!run) return null
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    concurrency: run.concurrency,
    start_stagger_ms: run.start_stagger_ms ?? SESSION_START_STAGGER_MS,
    turns: run.turns,
    models: run.models,
    stocks: run.stocks,
    max_tokens: run.max_tokens,
    report_day: run.reportDay || null,
    reports_dir: run.reportDay ? `${REPORTS_PUBLIC_ROOT}/${run.reportDay}` : null,
    stream: run.stream,
    error: run.error,
    summary: summarizeRun(run),
    report_markdown: run.status === 'ok' || run.status === 'error' || run.status === 'cancelled'
      ? renderMarkdown(run)
      : null,
    sessions: run.sessions.map((s) => publicSession(s, { includeText })),
  }
}

function parseSseBuffer(buffer, onEvent) {
  let rest = buffer
  for (;;) {
    const idx = rest.indexOf('\n')
    if (idx < 0) return rest
    let line = rest.slice(0, idx)
    rest = rest.slice(idx + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      onEvent(JSON.parse(raw))
    } catch {}
  }
}

async function consumeMessagesResponse(res, { onFirstByte } = {}) {
  const status = res.status
  const headers = {}
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
  if (status < 200 || status >= 300) {
    let body = null
    try { body = await res.json() } catch {
      try { body = { error: { message: await res.text() } } } catch { body = { error: { message: 'upstream error' } } }
    }
    return { ok: false, status, headers, body, text: '', blocks: [], usage: null, stop_reason: null, ttft_ms: null }
  }

  const ctype = String(headers['content-type'] || '')
  if (!ctype.includes('text/event-stream') && !ctype.includes('text/plain')) {
    const body = await res.json().catch(() => null)
    const blocks = Array.isArray(body?.content) ? body.content : []
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
    return {
      ok: true,
      status,
      headers,
      body,
      text,
      blocks,
      usage: body?.usage || null,
      stop_reason: body?.stop_reason || null,
      ttft_ms: null,
    }
  }

  const blocks = []
  let usage = null
  let stopReason = null
  let ttftMs = null
  let lastError = null
  const started = Date.now()
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return
    if (ttftMs == null && (ev.type === 'content_block_delta' || ev.type === 'content_block_start')) {
      ttftMs = Date.now() - started
      if (typeof onFirstByte === 'function') onFirstByte(ttftMs)
    }
    if (ev.type === 'message_start' && ev.message?.usage) usage = { ...usage, ...ev.message.usage }
    if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
      if (ev.usage) usage = { ...usage, ...ev.usage }
    }
    if (ev.type === 'content_block_start' && ev.content_block) {
      blocks[ev.index] = { ...ev.content_block }
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index] || {}
      const d = ev.delta || {}
      if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '')
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '')
      else if (d.type === 'signature_delta' && d.signature) b.signature = d.signature
      else if (d.type === 'input_json_delta') b.input_json = (b.input_json || '') + (d.partial_json || '')
      blocks[ev.index] = b
    } else if (ev.type === 'error') {
      lastError = ev.error || ev
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    buf = parseSseBuffer(buf, onEvent)
  }
  if (buf) parseSseBuffer(buf + '\n', onEvent)

  const compact = blocks.filter(Boolean)
  const text = compact.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
  if (lastError) {
    return {
      ok: false,
      status,
      headers,
      body: { error: lastError },
      text,
      blocks: compact,
      usage,
      stop_reason: stopReason,
      ttft_ms: ttftMs,
    }
  }
  return {
    ok: true,
    status,
    headers,
    body: { type: 'message', role: 'assistant', content: compact, usage, stop_reason: stopReason },
    text,
    blocks: compact,
    usage,
    stop_reason: stopReason,
    ttft_ms: ttftMs,
  }
}

async function postTurn({ baseUrl, apiKey, model, messages, maxTokens, sessionId, stream, signal, timeoutMs }) {
  const caps = getCapabilities(model) || {}
  const body = {
    model,
    max_tokens: maxTokens,
    stream: !!stream,
    messages,
  }
  if (caps.requires_adaptive || caps.thinking_mode === 'adaptive_only' || /claude-(opus|sonnet|fable)-5/.test(model)) {
    body.thinking = { type: 'adaptive' }
  }
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'user-agent': TEST_UA,
        'x-session-id': sessionId,
        accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    return await consumeMessagesResponse(res)
  } catch (e) {
    const aborted = ac.signal.aborted
    return {
      ok: false,
      status: 0,
      headers: {},
      body: {
        error: {
          type: aborted ? 'cancelled' : 'worker_error',
          code: aborted ? 'aborted' : (e.cause?.code || e.code || 'fetch_error'),
          message: aborted ? 'cancelled' : String(e.message || e).slice(0, 300),
        },
      },
      text: '',
      blocks: [],
      usage: null,
      stop_reason: null,
      ttft_ms: null,
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function assistantMessage(result) {
  const blocks = (result.blocks || []).filter((b) => b && (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking'))
  if (blocks.length) {
    const content = blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text || '' }
      if (b.type === 'thinking') {
        const out = { type: 'thinking', thinking: b.thinking || '' }
        if (b.signature) out.signature = b.signature
        return out
      }
      return { ...b }
    })
    return { role: 'assistant', content }
  }
  return { role: 'assistant', content: result.text || '' }
}

function persistTurnText(run, session, rec) {
  if (!run?.dataDir || !rec) return null
  const day = run.reportDay || shanghaiDay()
  const name = turnFileName(session, rec.n)
  try {
    const dir = ensureReportsDir(run.dataDir, day)
    const dest = path.join(dir, name)
    const header = [
      `<!-- run=${run.id} session=${session.id} model=${session.model} ticker=${session.stock.ticker} turn=${rec.n} ts=${nowIso()} -->`,
      '',
    ].join('\n')
    fs.writeFileSync(dest, header + String(rec.text || rec.error || ''))
    fs.appendFileSync(path.join(dir, 'records.jsonl'), `${JSON.stringify({
      ts: nowIso(),
      run_id: run.id,
      session: session.index + 1,
      ticker: session.stock.ticker,
      model: session.model,
      turn: rec.n,
      file: name,
      chars: rec.chars || 0,
      ok: !!rec.ok,
    })}\n`)
    rec.saved_path = `${day}/${name}`
    return rec.saved_path
  } catch {
    return null
  }
}

function persistRun(run, dataDir) {
  if (!dataDir) return
  try {
    const dir = path.join(dataDir, 'loadtests')
    fs.mkdirSync(dir, { recursive: true })
    const payload = publicRun(run, { includeText: true })
    payload.report_markdown = renderMarkdown(run)
    fs.writeFileSync(path.join(dir, `${run.id}.json`), JSON.stringify(payload, null, 2))
    fs.writeFileSync(path.join(dir, `${run.id}.md`), payload.report_markdown)
  } catch {}
}

export function listSavedReports(dataDir, day = null) {
  const root = reportsRoot(dataDir)
  const days = []
  try {
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(root, name)).isDirectory()) days.push(name)
      }
    }
  } catch {}
  days.sort().reverse()
  const pick = day && days.includes(day) ? day : (days[0] || null)
  const items = []
  if (pick) {
    try {
      const dir = path.join(root, pick)
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue
        const st = fs.statSync(path.join(dir, name))
        items.push({
          day: pick,
          name,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
          path: `${REPORTS_PUBLIC_ROOT}/${pick}/${name}`,
        })
      }
    } catch {}
    items.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
  }
  return {
    root: REPORTS_PUBLIC_ROOT,
    days,
    day: pick,
    items,
  }
}

export function readSavedReport(dataDir, day, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return null
  if (!/^[A-Za-z0-9._-]+\.md$/.test(String(name || ''))) return null
  const root = path.resolve(reportsRoot(dataDir))
  const file = path.resolve(root, day, name)
  if (file !== path.join(root, day, name) && !file.startsWith(root + path.sep)) return null
  if (!fs.existsSync(file)) return null
  return {
    day,
    name,
    path: `${REPORTS_PUBLIC_ROOT}/${day}/${name}`,
    text: fs.readFileSync(file, 'utf8'),
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function runSessionsStaggered(run) {
  const tasks = []
  try {
    for (let i = 0; i < run.sessions.length; i++) {
      if (run.abort.signal.aborted) break
      if (i > 0) await sleep(run.start_stagger_ms ?? SESSION_START_STAGGER_MS, run.abort.signal)
      if (run.abort.signal.aborted) break
      tasks.push(runSession(run, run.sessions[i]))
    }
  } catch (e) {
    if (e?.name !== 'AbortError') throw e
  }
  if (tasks.length) await Promise.all(tasks)
}

async function runSession(run, session) {
  const started = Date.now()
  session.status = 'running'
  session.started_at = nowIso()
  const messages = []
  try {
    for (let n = 1; n <= session.plannedTurns; n++) {
      if (run.abort.signal.aborted) {
        session.status = 'cancelled'
        session.error = 'cancelled'
        break
      }
      session.turn = n
      const destPath = promptWritePath(run.reportDay || shanghaiDay(), session, n)
      const prompt = n === 1 ? buildReportPrompt(session.stock, destPath) : buildFollowupPrompt(session.stock, n, destPath)
      messages.push({ role: 'user', content: prompt })
      const turnStarted = Date.now()
      const rec = {
        n,
        ok: false,
        status: 0,
        duration_ms: 0,
        ttft_ms: null,
        chars: 0,
        stop_reason: null,
        usage: null,
        preview: '',
        text: '',
        saved_path: `${run.reportDay || shanghaiDay()}/${turnFileName(session, n)}`,
        error: null,
        finished: false,
      }
      session.turns.push(rec)
      const result = await postTurn({
        baseUrl: run.baseUrl,
        apiKey: run.apiKey,
        model: session.model,
        messages,
        maxTokens: run.max_tokens,
        sessionId: session.session_id,
        stream: run.stream,
        signal: run.abort.signal,
        timeoutMs: run.timeoutMs,
      })
      rec.status = result.status
      rec.duration_ms = Date.now() - turnStarted
      rec.ttft_ms = result.ttft_ms
      rec.usage = result.usage
      rec.stop_reason = result.stop_reason
      rec.text = result.text || ''
      rec.chars = rec.text.length
      rec.preview = clip(rec.text, 280)
      rec.finished = true
      persistTurnText(run, session, rec)
      if (!result.ok) {
        const err = result.body?.error || {}
        rec.error = String(err.message || err.type || `status ${result.status}`).slice(0, 400)
        rec.ok = false
        session.status = 'error'
        session.error = `turn ${n}: ${rec.error}`
        break
      }
      rec.ok = true
      messages.push(assistantMessage(result))
    }
    if (session.status === 'running') session.status = 'ok'
  } catch (e) {
    session.status = 'error'
    session.error = String(e.message || e).slice(0, 400)
  } finally {
    session.duration_ms = Date.now() - started
    session.finished_at = nowIso()
  }
}

export function listConcurrentTests() {
  return [...runs.values()].map((r) => publicRun(r)).reverse()
}

export function getConcurrentTest(id, { includeText = false } = {}) {
  const opts = { includeText }
  if (id) return publicRun(runs.get(id) || null, opts)
  if (activeId && runs.has(activeId)) return publicRun(runs.get(activeId), opts)
  const last = [...runs.values()].at(-1)
  return publicRun(last || null, opts)
}

export function cancelConcurrentTest(id) {
  const run = runs.get(id) || (activeId ? runs.get(activeId) : null)
  if (!run) return { ok: false, error: { code: 'not_found', message: 'no run' } }
  if (run.status === 'running') {
    run.abort.abort()
    run.status = 'cancelling'
  }
  return { ok: true, data: publicRun(run) }
}

export function startConcurrentTest(opts = {}) {
  if (activeId && runs.get(activeId)?.status === 'running') {
    return { ok: false, error: { code: 'run_in_progress', message: '已有压测在运行，请等待结束或取消' }, data: publicRun(runs.get(activeId)) }
  }
  const concurrency = Math.max(1, Math.min(20, Number(opts.concurrency) || 10))
  const turns = Math.max(1, Math.min(3, Number(opts.turns) || 2))
  const models = normalizeModels(opts.models)
  const stocks = normalizeStocks(opts.stocks)
  const maxTokens = resolveMaxTokens(opts.max_tokens)
  const stream = opts.stream !== false
  const timeoutMs = Math.max(
    30000,
    Math.min(600000, Number(opts.timeout_ms) || Math.max(180000, maxTokens * 12)),
  )
  const baseUrl = String(opts.baseUrl || 'http://127.0.0.1:8787').replace(/\/$/, '')
  const apiKey = opts.apiKey
  if (!apiKey) {
    return { ok: false, error: { code: 'missing_api_key', message: 'gateway master key missing' } }
  }

  const id = `lt_${Date.now().toString(16)}_${crypto.randomBytes(3).toString('hex')}`
  const sessions = []
  for (let i = 0; i < concurrency; i++) {
    const stock = stocks[i % stocks.length]
    const model = models[i % models.length]
    sessions.push({
      id: `${id}_s${i + 1}`,
      index: i,
      stock,
      model,
      session_id: crypto.randomUUID(),
      plannedTurns: turns,
      turn: 0,
      status: 'pending',
      duration_ms: 0,
      error: null,
      turns: [],
    })
  }

  const run = {
    id,
    status: 'running',
    started_at: nowIso(),
    finished_at: null,
    duration_ms: 0,
    concurrency,
    start_stagger_ms: SESSION_START_STAGGER_MS,
    turns,
    models,
    stocks,
    max_tokens: maxTokens,
    stream,
    timeoutMs,
    baseUrl,
    apiKey,
    dataDir: opts.dataDir || null,
    reportDay: shanghaiDay(),
    abort: new AbortController(),
    error: null,
    sessions,
  }
  if (run.dataDir) {
    try { ensureReportsDir(run.dataDir, run.reportDay) } catch {}
  }
  runs.set(id, run)
  activeId = id
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value
    if (oldest === id) break
    runs.delete(oldest)
  }

  const started = Date.now()
  runSessionsStaggered(run)
    .then(() => {
      if (run.abort.signal.aborted && run.sessions.some((s) => s.status === 'cancelled')) {
        run.status = 'cancelled'
      } else if (run.sessions.every((s) => s.status === 'ok')) {
        run.status = 'ok'
      } else {
        run.status = 'error'
      }
    })
    .catch((e) => {
      run.status = 'error'
      run.error = String(e.message || e).slice(0, 400)
    })
    .finally(() => {
      run.finished_at = nowIso()
      run.duration_ms = Date.now() - started
      if (activeId === id) activeId = null
      persistRun(run, run.dataDir)
    })

  return { ok: true, data: publicRun(run) }
}
