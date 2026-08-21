/**
 * Capability + answer-form probes for the loadtest page.
 *
 * Inbound is official Claude Code body/headers (no third-party UA).
 * Loopback /v1/messages so outbound uses the same prepareOutboundAttempt path.
 * Upstream prompts are ordinary tasks. No training / teacher / student wording.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getCapabilities } from '../protocol/model-policy.mjs'
import { claudeCodeInboundBody, claudeCodeInboundHeaders } from '../protocol/claude-code-inbound.mjs'
import {
  beginTestJob,
  endTestJob,
  getTestJob,
  isTestJobBusy,
  markTestJob,
  busyMessage,
} from './test-job-lock.mjs'

const ABSOLUTE_MAX_TOKENS = 128000
const MAX_RUNS = 8
export const DEFAULT_PROBE_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5']
export const FORM_KINDS = [
  { id: 'answer', label: '只答' },
  { id: 'reason', label: '分步' },
  { id: 'mixed', label: '先答后补' },
]

const runs = new Map()
let lastId = null

function nowIso() {
  return new Date().toISOString()
}

function clip(s, n = 280) {
  const t = String(s || '')
  return t.length <= n ? t : t.slice(0, n) + '…'
}

export function normalizeProbeModels(input) {
  const list = (Array.isArray(input) && input.length ? input : DEFAULT_PROBE_MODELS)
    .map((id) => String(id || '').trim())
    .filter((id) => /^claude-(opus|sonnet|fable|haiku)-[a-z0-9.-]+$/i.test(id))
  return list.length ? [...new Set(list)] : [...DEFAULT_PROBE_MODELS]
}

export function stripFences(text) {
  let t = String(text || '').trim()
  t = t.replace(/^```(?:json|txt|text)?\s*/i, '')
  t = t.replace(/\s*```$/i, '')
  return t.trim()
}

export function parseJsonLoose(text) {
  const t = stripFences(text)
  if (!t) return null
  try { return JSON.parse(t) } catch {}
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch {}
  }
  return null
}

export function thinkingTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  const details = usage.output_tokens_details || usage.output_tokens_detail || {}
  return Number(details.thinking_tokens || usage.thinking_tokens || 0) || 0
}

export function classifyAnomalies(result = {}) {
  const anomalies = []
  const status = Number(result.status) || 0
  const visible = String(result.text || '').trim()
  const think = thinkingTokens(result.usage)
  const stop = String(result.stop_reason || '')
  if (!result.ok || status < 200 || status >= 300) anomalies.push('http')
  if (!visible) anomalies.push('empty')
  if (!visible && think > 0) anomalies.push('thinking_only')
  if (stop === 'max_tokens') anomalies.push('truncated')
  if (stop === 'refusal') anomalies.push('refusal')
  if (/i(?:'m| am) claude|anthropic/i.test(visible) && /not able|don't execute|test or probe|clarif/i.test(visible)) {
    anomalies.push('deflected')
  }
  return [...new Set(anomalies)]
}

export function deepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) {
    if ((typeof a === 'number' || typeof a === 'string') && (typeof b === 'number' || typeof b === 'string')) {
      return String(a) === String(b)
    }
    return false
  }
  if (typeof a !== 'object') return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length) return false
  return ak.every((k, i) => k === bk[i] && deepEqual(a[k], b[k]))
}

export function extractFinalAnswer(text) {
  const raw = String(text || '')
  const tagged = raw.match(/最终答案\s*[:：]\s*([^\n]+)/)
  if (tagged) return tagged[1].trim()
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

export function normalizeAnswerToken(s) {
  let t = String(s || '').trim()
  t = t.replace(/^["'`]+|["'`]+$/g, '')
  t = t.replace(/^(最终答案|答案)\s*[:：]\s*/u, '')
  t = t.replace(/[。.;；]+$/u, '')
  t = t.replace(/元$|小时$|人$|米$|度$/u, '')
  t = t.replace(/,/g, '').trim()
  return t
}

export function numericClose(got, gold, eps = 1e-6) {
  const parse = (v) => {
    const t = normalizeAnswerToken(v)
    if (!t) return null
    const frac = t.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/)
    if (frac) return Number(frac[1]) / Number(frac[2])
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  const a = parse(got)
  const b = parse(gold)
  if (a == null || b == null) return false
  const scale = Math.max(1, Math.abs(b))
  return Math.abs(a - b) <= Math.max(eps, scale * 1e-6)
}

export function answersMatch(got, gold) {
  if (gold == null) return false
  if (typeof gold === 'object') {
    const parsed = parseJsonLoose(got)
    return parsed ? deepEqual(parsed, gold) : false
  }
  const g = normalizeAnswerToken(gold)
  const raw = normalizeAnswerToken(extractFinalAnswer(got) || got)
  if (!g) return false
  if (raw === g) return true
  if (raw.toLowerCase() === g.toLowerCase()) return true
  if (numericClose(raw, g) || numericClose(got, g)) return true
  const body = normalizeAnswerToken(stripFences(got))
  return body === g || numericClose(body, g)
}

export function hasReasoningText(text) {
  const t = String(text || '').trim()
  if (!t) return false
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length >= 3) return true
  const withoutAnswer = t.replace(/最终答案\s*[:：]\s*[^\n]+/g, '').trim()
  if (withoutAnswer.length >= 18) return true
  if (t.length < 16) return false
  return /第一步|第二|因此|所以|因为|先算|先按|再算|再打|分步|推理|利润|折扣|step\s*1|thus|therefore/i.test(t)
}

export function buildNeedleFiller(targetChars = 24000) {
  const lines = []
  let i = 1
  let chars = 0
  const lineAt = (n) => `row ${String(n).padStart(4, '0')}: ledger note ${((n * 17) % 997)} — placeholder inventory, no special marker.`
  while (chars < targetChars) {
    const line = lineAt(i)
    lines.push(line)
    chars += line.length + (lines.length > 1 ? 1 : 0)
    i++
  }
  const aAt = Math.max(0, Math.floor(lines.length * 0.22))
  const bAt = Math.min(lines.length - 1, Math.floor(lines.length * 0.78))
  lines[aAt] = `row ${String(aAt + 1).padStart(4, '0')}: ALPHA-CODE: Q7-MINT`
  lines[bAt] = `row ${String(bAt + 1).padStart(4, '0')}: OMEGA-CODE: Z9-PLUM`
  let text = lines.join('\n')
  let n = i
  while (text.length < targetChars) {
    text += `\n${lineAt(n)}`
    n++
  }
  return {
    text,
    gold: { alpha: 'Q7-MINT', omega: 'Z9-PLUM' },
    chars: text.length,
  }
}

const NEEDLE = buildNeedleFiller()

export const CAPABILITY_CASES = [
  {
    id: 'follow',
    label: '指令复述',
    max_tokens: 2048,
    timeout_ms: 60000,
    gold: 'BEGIN-09D0CECA-END',
    system: '',
    user: '请原样输出下面这一行，不要添加空格、换行或解释：\nBEGIN-09D0CECA-END',
  },
  {
    id: 'spatial',
    label: '空间颜色',
    max_tokens: 2048,
    timeout_ms: 60000,
    gold: { top_left: 'red', bottom_right: 'yellow' },
    system: '',
    user: [
      '观察下面的四宫格（从观察者视角）：',
      '第一行：红 | 蓝',
      '第二行：绿 | 黄',
      '请用英文颜色词填写，只输出 JSON：{"top_left":"","bottom_right":""}',
    ].join('\n'),
  },
  {
    id: 'needle',
    label: '长文检索',
    max_tokens: 4096,
    timeout_ms: 120000,
    gold: NEEDLE.gold,
    system: '',
    user: [
      '下面是一份流水账。请找出 ALPHA-CODE 与 OMEGA-CODE 的值。',
      '只输出 JSON：{"alpha":"","omega":""}',
      '',
      NEEDLE.text,
    ].join('\n'),
  },
  {
    id: 'numbers',
    label: '计算',
    max_tokens: 32000,
    timeout_ms: 240000,
    gold: {
      arithmetic: 12530,
      modular: 801,
      crt: 23,
      binary_count: 8,
      reverse: 'a74-KrDb',
    },
    system: '',
    user: [
      '请根据下面五问给出结果，只输出一个 JSON 对象，键名必须是：',
      'arithmetic, modular, crt, binary_count, reverse',
      '1. 计算 125 × 98 + 280',
      '2. 计算 7 的 8 次方除以 1000 的余数',
      '3. 求最小正整数 n，使 n 除以 3 余 2，除以 5 余 3，除以 7 余 2',
      '4. 将 2026 写成二进制后，数字 1 出现几次',
      '5. 把字符串 bDrK-47a 前后颠倒（保留原字符，包括短横线）',
    ].join('\n'),
  },
  {
    id: 'extract',
    label: '字段抽取',
    max_tokens: 2048,
    timeout_ms: 60000,
    gold: { code: 'KIN-314', owner: '林舟', due: '2026-09-01', status: '进行中' },
    system: '',
    user: [
      '从下面这段话提取字段，只输出 JSON：',
      '会议纪要：项目编号 KIN-314，负责人 林舟，截止日期 2026-09-01，状态 进行中。',
      '{"code":"","owner":"","due":"","status":""}',
    ].join('\n'),
  },
]

export const FORM_QUESTIONS = [
  { id: 'q1', label: '定价折扣', gold: '86.4', user: '一件商品进价 80 元，按 20% 利润定价后打 9 折出售。实际售价是多少元？' },
  { id: 'q2', label: '相遇', gold: '2.571428', accept: ['2.57', '18/7', '2.571', '2.5714'], user: '甲乙两地相距 360 千米。客车时速 80，货车时速 60，同时相向开出。多少小时后相遇？' },
  { id: 'q3', label: '圆周长', gold: '44', user: '一个圆形花坛半径 7 米。周长是多少米？（π 取 22/7）' },
  { id: 'q4', label: '人数', gold: '24', user: '某班 40 人，女生比男生多 8 人。女生有多少人？' },
  { id: 'q5', label: '三点夹角', gold: '90', user: '一个时钟 3 点整，时针和分针的夹角是多少度？' },
  { id: 'q6', label: '球棒', gold: '0.05', accept: ['5分', '5 分', '$0.05'], user: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?' },
  { id: 'q7', label: '圆面积', gold: '154', user: '一个圆半径 7 米。面积是多少平方米？（π 取 22/7）' },
  { id: 'q8', label: '连加', gold: '5050', user: '1 到 100 的所有正整数之和是多少？' },
  { id: 'q9', label: '幂', gold: '1024', user: '2 的 10 次方等于多少？' },
  { id: 'q10', label: '百分数', gold: '12', user: '80 的 15% 是多少？' },
  { id: 'q11', label: '最大公约数', gold: '6', user: '48 和 18 的最大公约数是多少？' },
  { id: 'q12', label: '最小公倍数', gold: '12', user: '4 和 6 的最小公倍数是多少？' },
  { id: 'q13', label: '阶乘', gold: '5040', user: '7 的阶乘等于多少？' },
  { id: 'q14', label: '六点夹角', gold: '180', user: '一个时钟 6 点整，时针和分针的夹角是多少度？' },
  { id: 'q15', label: '正方形', gold: '25', user: '边长 5 厘米的正方形，面积是多少平方厘米？' },
  { id: 'q16', label: '分数加', gold: '11/12', accept: ['0.916666', '0.917'], user: '计算 3/4 + 1/6，结果写成最简分数。' },
  { id: 'q17', label: '混合运算', gold: '26', user: '计算 100 − 37 × 2。' },
  { id: 'q18', label: '平均数', gold: '18', user: '12、18、24 三个数的平均数是多少？' },
  { id: 'q19', label: '路程', gold: '150', user: '一辆车以 60 千米/小时行驶 2.5 小时，路程是多少千米？' },
  { id: 'q20', label: '二进制', gold: '3', user: '把 13 写成二进制后，数字 1 出现几次？' },
  { id: 'q21', label: '数字倒序', gold: '6202', user: '把四位数 2026 的各位数字前后颠倒，得到什么数？' },
  { id: 'q22', label: '公倍数', gold: '24', user: '8 和 12 的最小公倍数是多少？' },
  { id: 'q23', label: '等差', gold: '40', user: '等差数列 2、5、8、11、14 的和是多少？' },
  { id: 'q24', label: '组合', gold: '10', user: '从 5 个人里选 2 个人，有多少种选法？' },
]

export const DEFAULT_FORM_SAMPLE = 4

export function mulberry32(seed) {
  let a = Number(seed) >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickFromPool(pool, opts, defaultSample) {
  const source = pool.length ? [...pool] : []
  const raw = Number(opts.sample ?? opts.sample_size)
  const fallback = Number.isFinite(defaultSample) && defaultSample > 0 ? defaultSample : source.length
  const sample = Math.max(1, Math.min(source.length || 1, Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback))
  const random = opts.random !== false
  if (!source.length) return { items: [], sample: 0, seed: null, random, bank: 0 }
  if (!random) {
    return { items: source.slice(0, sample), sample, seed: null, random: false, bank: opts.bank ?? source.length }
  }
  const seed = opts.seed == null || opts.seed === ''
    ? crypto.randomBytes(4).readUInt32BE(0)
    : (Number(opts.seed) >>> 0) || 1
  const rng = mulberry32(seed)
  const shuffled = [...source]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return { items: shuffled.slice(0, sample), sample, seed, random: true, bank: opts.bank ?? source.length }
}

export function pickFormQuestions(opts = {}) {
  const allow = Array.isArray(opts.questions) && opts.questions.length
    ? new Set(opts.questions.map(String))
    : null
  const pool = allow
    ? FORM_QUESTIONS.filter((q) => allow.has(q.id))
    : [...FORM_QUESTIONS]
  return pickFromPool(pool.length ? pool : [...FORM_QUESTIONS], opts, DEFAULT_FORM_SAMPLE)
}

export function pickCapabilityCases(opts = {}) {
  const allow = Array.isArray(opts.cases) && opts.cases.length
    ? new Set(opts.cases.map(String))
    : null
  const pool = allow
    ? CAPABILITY_CASES.filter((c) => allow.has(c.id))
    : [...CAPABILITY_CASES]
  const source = pool.length ? pool : [...CAPABILITY_CASES]
  const hasSample = Number(opts.sample ?? opts.sample_size) > 0
  return pickFromPool(source, { ...opts, bank: CAPABILITY_CASES.length }, hasSample ? Number(opts.sample ?? opts.sample_size) : source.length)
}

const ANSWER_ONLY = '只写出最终结果，不要写过程。'
const REASON_ASK = '请分步解答。先写推理过程，最后单独一行写：\n最终答案：...'
const MIXED_FOLLOW = '请把推理过程补上，不要改最终结果。'

function formUser(kind, question) {
  if (kind === 'reason') return `${REASON_ASK}\n\n${question.user}`
  if (kind === 'mixed') return `${ANSWER_ONLY}\n\n${question.user}`
  return `${ANSWER_ONLY}\n\n${question.user}`
}

export function scoreCapability(caze, result) {
  const anomalies = classifyAnomalies(result)
  const exact = !!(result.ok && answersMatch(result.text, caze.gold))
  if (result.ok && !exact && String(result.text || '').trim()) anomalies.push('mismatch')
  return {
    exact,
    ok: exact && !anomalies.includes('http'),
    anomalies,
    parsed: typeof caze.gold === 'object' ? parseJsonLoose(result.text) : stripFences(result.text),
  }
}

export function scoreForm(question, kind, turns) {
  const first = turns[0] || {}
  const second = turns[1] || {}
  const anomalies = [...classifyAnomalies(first)]
  if (kind === 'mixed' && turns[1]) {
    for (const a of classifyAnomalies(second)) {
      if (!anomalies.includes(a)) anomalies.push(a)
    }
  }
  const got = kind === 'mixed' ? (first.text || second.text || '') : (first.text || '')
  const exact = answersMatch(got, question.gold)
    || (question.accept || []).some((alt) => answersMatch(got, alt))
    || (kind === 'mixed' && (answersMatch(second.text, question.gold) || (question.accept || []).some((alt) => answersMatch(second.text, alt))))
  const reasoned = kind === 'answer'
    ? true
    : hasReasoningText(kind === 'mixed' ? (second.text || '') : (first.text || ''))
  if (kind !== 'answer' && !reasoned && String((kind === 'mixed' ? second.text : first.text) || '').trim()) {
    anomalies.push('no_reason')
  }
  if (!exact && String(got || '').trim()) anomalies.push('mismatch')
  return {
    exact,
    reasoned,
    ok: exact && reasoned && !anomalies.includes('http'),
    anomalies,
    answer: extractFinalAnswer(got) || normalizeAnswerToken(got),
  }
}

export function getProbeCatalog() {
  return {
    suites: [
      {
        id: 'capability',
        label: '能力',
        cases: CAPABILITY_CASES.map((c) => ({
          id: c.id,
          label: c.label,
          max_tokens: c.max_tokens,
        })),
        bank: CAPABILITY_CASES.length,
        default_sample: 1,
      },
      {
        id: 'forms',
        label: '答题',
        forms: FORM_KINDS,
        bank: FORM_QUESTIONS.length,
        default_sample: DEFAULT_FORM_SAMPLE,
        questions: FORM_QUESTIONS.map((q) => ({ id: q.id, label: q.label })),
      },
    ],
    models: DEFAULT_PROBE_MODELS,
  }
}

export function sanitizeProbeHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase()
    if (key === 'authorization' || key === 'x-api-key' || key === 'cookie' || key === 'set-cookie') continue
    out[key] = v
  }
  return out
}

export function packProbeRaw(request, result = {}) {
  return {
    request: request || null,
    response: {
      ok: !!result.ok,
      status: result.status || 0,
      headers: sanitizeProbeHeaders(result.headers),
      stop_reason: result.stop_reason || null,
      usage: result.usage || null,
      body: result.body || null,
    },
    stream: {
      events: result.events || [],
      event_count: Number(result.event_count) || (result.events || []).length,
    },
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
    try { onEvent(JSON.parse(raw)) } catch {}
  }
}

async function consumeMessagesResponse(res, { onProgress } = {}) {
  const status = res.status
  const headers = {}
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
  const emit = (extra = {}) => {
    if (typeof onProgress !== 'function') return
    onProgress(extra)
  }
  if (status < 200 || status >= 300) {
    let body = null
    try { body = await res.json() } catch {
      try { body = { error: { message: await res.text() } } } catch { body = { error: { message: 'upstream error' } } }
    }
    return { ok: false, status, headers, body, text: '', usage: null, stop_reason: null, events: [], event_count: 0 }
  }
  const ctype = String(headers['content-type'] || '')
  if (!ctype.includes('text/event-stream') && !ctype.includes('text/plain')) {
    const body = await res.json().catch(() => null)
    const blocks = Array.isArray(body?.content) ? body.content : []
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
    const thinking = blocks.filter((b) => b?.type === 'thinking').map((b) => b.thinking || '').join('')
    emit({ phase: 'done', text, thinking, usage: body?.usage || null, events: 1 })
    return { ok: true, status, headers, body, text, thinking, usage: body?.usage || null, stop_reason: body?.stop_reason || null, blocks, events: [{ type: 'message' }], event_count: 1 }
  }
  const blocks = []
  let usage = null
  let stopReason = null
  let lastError = null
  const events = []
  let eventCount = 0
  let lastEmit = 0
  const started = Date.now()
  const snapshot = () => {
    const compact = blocks.filter(Boolean)
    const text = compact.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
    const thinking = compact.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('')
    const phase = text ? 'text' : (thinking ? 'thinking' : 'stream')
    return { phase, text, thinking, usage, events: eventCount, tokens_out: Number(usage?.output_tokens) || 0 }
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return
    eventCount++
    if (events.length < 80) events.push({ t: Date.now() - started, type: ev.type || 'event' })
    if (ev.type === 'message_start' && ev.message?.usage) usage = { ...usage, ...ev.message.usage }
    if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
      if (ev.usage) usage = { ...usage, ...ev.usage }
    }
    if (ev.type === 'content_block_start' && ev.content_block) blocks[ev.index] = { ...ev.content_block }
    else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index] || {}
      const d = ev.delta || {}
      if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '')
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '')
      blocks[ev.index] = b
    } else if (ev.type === 'error') lastError = ev.error || ev
    const now = Date.now()
    if (now - lastEmit >= 200) {
      lastEmit = now
      emit(snapshot())
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
  const thinking = compact.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('')
  emit({ ...snapshot(), phase: 'done', text, thinking })
  if (lastError) {
    return { ok: false, status, headers, body: { error: lastError }, text, thinking, usage, stop_reason: stopReason, blocks: compact, events, event_count: eventCount }
  }
  return { ok: true, status, headers, body: { content: compact, usage, stop_reason: stopReason }, text, thinking, usage, stop_reason: stopReason, blocks: compact, events, event_count: eventCount }
}

function assistantMessage(result) {
  const blocks = (result.blocks || []).filter((b) => b && (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking'))
  if (blocks.length) {
    return {
      role: 'assistant',
      content: blocks.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text || '' }
        if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking || '' }
        return { ...b }
      }),
    }
  }
  return { role: 'assistant', content: result.text || '' }
}

function attachStream(item, patch, maxTokens) {
  const next = { ...(item.stream || {}), max_tokens: maxTokens, ...(patch || {}) }
  item.stream = next
  if (patch?.text != null) {
    item.text = patch.text
    item.preview = clip(patch.text)
  }
  if (patch?.thinking != null) item.thinking = patch.thinking
  if (patch?.usage) item.usage = patch.usage
}

export function buildProbeTurnRequest({ model, messages, maxTokens, sessionId }) {
  const caps = getCapabilities(model) || {}
  let thinking = null
  if (caps.requires_adaptive || caps.thinking_mode === 'adaptive_only' || /claude-(opus|sonnet|fable)-5/.test(model) || /claude-opus-4-[5-8]/.test(model)) {
    thinking = { type: 'adaptive' }
  }
  const body = claudeCodeInboundBody({ model, messages, maxTokens, thinking, sessionId, stream: true })
  const headers = {
    ...claudeCodeInboundHeaders({ sessionId }),
    'x-session-id': sessionId,
  }
  return { body, headers }
}

async function postProbeTurn({ baseUrl, apiKey, model, messages, maxTokens, sessionId, signal, timeoutMs, onProgress }) {
  const { body, headers } = buildProbeTurnRequest({ model, messages, maxTokens, sessionId })
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
        ...headers,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const result = await consumeMessagesResponse(res, { onProgress })
    result.request = body
    return result
  } catch (e) {
    const aborted = ac.signal.aborted
    return {
      ok: false,
      status: 0,
      headers: {},
      body: {
        error: {
          type: aborted ? 'cancelled' : 'worker_error',
          message: aborted ? 'cancelled' : String(e.message || e).slice(0, 300),
        },
      },
      text: '',
      thinking: '',
      usage: null,
      stop_reason: null,
      events: [],
      event_count: 0,
      request: body,
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function resolveCaseMaxTokens(caze, ceiling) {
  const want = Number(caze.max_tokens) || 2048
  const cap = Number(ceiling) || ABSOLUTE_MAX_TOKENS
  return Math.min(ABSOLUTE_MAX_TOKENS, Math.max(1, Math.min(want, cap)))
}

function buildJobs(opts) {
  const models = normalizeProbeModels(opts.models)
  const suite = String(opts.suite || 'capability')
  const jobs = []
  let capPick = null
  if (suite === 'capability' || suite === 'all') {
    capPick = pickCapabilityCases({
      cases: opts.cases,
      sample: opts.sample ?? opts.sample_size,
      random: opts.random,
      seed: opts.seed,
    })
    for (const model of models) {
      for (const caze of capPick.items) {
        jobs.push({
          suite: 'capability',
          model,
          case_id: caze.id,
          label: caze.label,
          form: null,
          question_id: null,
        })
      }
    }
  }
  let pick = null
  if (suite === 'forms' || suite === 'all') {
    const forms = (Array.isArray(opts.forms) && opts.forms.length ? opts.forms : FORM_KINDS.map((f) => f.id))
      .map(String)
      .filter((id) => FORM_KINDS.some((f) => f.id === id))
    pick = pickFormQuestions({
      questions: opts.questions,
      sample: opts.sample ?? opts.sample_size,
      random: opts.random,
      seed: opts.seed,
    })
    for (const model of models) {
      for (const form of forms) {
        for (const q of pick.items) {
          jobs.push({
            suite: 'forms',
            model,
            case_id: `${form}:${q.id}`,
            label: q.label,
            form,
            question_id: q.id,
          })
        }
      }
    }
  }
  return { models, jobs, pick, capPick }
}

function summarizeRun(run) {
  const items = run.items || []
  const finished = items.filter((x) => x.status === 'ok' || x.status === 'error' || x.status === 'cancelled')
  const exact = items.filter((x) => x.exact).length
  const anomalies = {}
  for (const x of items) {
    for (const a of x.anomalies || []) anomalies[a] = (anomalies[a] || 0) + 1
  }
  const byModel = {}
  for (const x of items) {
    const b = byModel[x.model] || { total: 0, exact: 0, anomaly: 0 }
    b.total++
    if (x.exact) b.exact++
    if ((x.anomalies || []).length) b.anomaly++
    byModel[x.model] = b
  }
  return {
    total: items.length,
    finished: finished.length,
    exact,
    mismatch: items.filter((x) => (x.anomalies || []).includes('mismatch')).length,
    empty: items.filter((x) => (x.anomalies || []).includes('empty')).length,
    truncated: items.filter((x) => (x.anomalies || []).includes('truncated')).length,
    refusal: items.filter((x) => (x.anomalies || []).includes('refusal')).length,
    thinking_only: items.filter((x) => (x.anomalies || []).includes('thinking_only')).length,
    running: items.filter((x) => x.status === 'running').length,
    pending: items.filter((x) => x.status === 'pending').length,
    progress: items.length ? +((finished.length / items.length) * 100).toFixed(1) : 0,
    accuracy: items.length ? +(exact / items.length).toFixed(3) : 0,
    anomalies,
    by_model: byModel,
  }
}

function publicItem(item, { includeText = false } = {}) {
  return {
    id: item.id,
    suite: item.suite,
    model: item.model,
    case_id: item.case_id,
    label: item.label,
    form: item.form,
    question_id: item.question_id,
    status: item.status,
    http: item.http,
    exact: item.exact,
    reasoned: item.reasoned,
    ok: item.ok,
    anomalies: item.anomalies,
    stop_reason: item.stop_reason,
    duration_ms: item.duration_ms,
    usage: item.usage,
    preview: item.preview,
    error: item.error,
    answer: item.answer,
    stream: item.stream || null,
    thinking_chars: String(item.thinking || '').length,
    raw_summary: {
      status: item.http || item.raw?.response?.status || 0,
      error: item.error || item.raw?.response?.body?.error?.message || null,
      request_model: item.raw?.request?.model || item.model || null,
      response_error: item.raw?.response?.body?.error || null,
    },
    text: includeText ? item.text : undefined,
    thinking: includeText ? item.thinking : undefined,
    turns: includeText ? item.turns : undefined,
    raw: includeText ? item.raw : undefined,
  }
}

function publicRun(run, { includeText = false } = {}) {
  if (!run) return null
  return {
    kind: 'probe',
    id: run.id,
    suite: run.suite,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    models: run.models,
    forms: run.forms,
    questions: run.questions,
    sample: run.sample ?? null,
    seed: run.seed ?? null,
    random: run.random ?? null,
    bank: run.bank ?? FORM_QUESTIONS.length,
    cases: run.cases,
    max_tokens: run.max_tokens,
    concurrency: run.concurrency,
    error: run.error,
    summary: summarizeRun(run),
    items: run.items.map((x) => publicItem(x, { includeText })),
  }
}

function persistRun(run) {
  if (!run?.dataDir) return
  try {
    const dir = path.join(run.dataDir, 'loadtests', 'probes')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${run.id}.json`), JSON.stringify(publicRun(run, { includeText: true }), null, 2))
  } catch {}
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

async function runOneCapability(run, item) {
  const caze = CAPABILITY_CASES.find((c) => c.id === item.case_id)
  if (!caze) {
    item.status = 'error'
    item.error = 'unknown case'
    return
  }
  const messages = []
  if (caze.system) messages.push({ role: 'user', content: caze.system })
  messages.push({ role: 'user', content: caze.user })
  const maxTokens = resolveCaseMaxTokens(caze, run.max_tokens)
  attachStream(item, { phase: 'start', events: 0, chars: 0, thinking_chars: 0, tokens_out: 0 }, maxTokens)
  const result = await postProbeTurn({
    baseUrl: run.baseUrl,
    apiKey: run.apiKey,
    model: item.model,
    messages,
    maxTokens,
    sessionId: item.session_id,
    signal: run.abort.signal,
    timeoutMs: caze.timeout_ms || run.timeoutMs,
    onProgress: (p) => attachStream(item, {
      phase: p.phase,
      events: p.events,
      chars: String(p.text || '').length,
      thinking_chars: String(p.thinking || '').length,
      tokens_out: p.tokens_out,
      text: p.text,
      thinking: p.thinking,
      usage: p.usage,
    }, maxTokens),
  })
  const scored = scoreCapability(caze, result)
  item.http = result.status
  item.text = result.text || ''
  item.thinking = result.thinking || item.thinking || ''
  item.usage = result.usage
  item.stop_reason = result.stop_reason
  item.exact = scored.exact
  item.ok = scored.ok
  item.anomalies = scored.anomalies
  item.preview = clip(item.text)
  item.answer = typeof caze.gold === 'object' ? scored.parsed : stripFences(item.text)
  item.raw = packProbeRaw(result.request, result)
  attachStream(item, { phase: 'done', chars: item.text.length, thinking_chars: String(item.thinking || '').length, tokens_out: Number(result.usage?.output_tokens) || 0, events: result.event_count }, maxTokens)
  if (!result.ok) item.error = String(result.body?.error?.message || `status ${result.status}`).slice(0, 400)
  item.status = run.abort.signal.aborted ? 'cancelled' : (result.ok ? 'ok' : 'error')
}

async function runOneForm(run, item) {
  const q = FORM_QUESTIONS.find((x) => x.id === item.question_id)
  if (!q) {
    item.status = 'error'
    item.error = 'unknown question'
    return
  }
  const messages = [{ role: 'user', content: formUser(item.form, q) }]
  const maxTokens = resolveCaseMaxTokens({ max_tokens: item.form === 'answer' ? 4096 : 8192 }, run.max_tokens)
  attachStream(item, { phase: 'start', events: 0, chars: 0, thinking_chars: 0, tokens_out: 0, turn: 1 }, maxTokens)
  const onTurn = (n) => (p) => attachStream(item, {
    phase: p.phase,
    events: p.events,
    chars: String(p.text || '').length,
    thinking_chars: String(p.thinking || '').length,
    tokens_out: p.tokens_out,
    text: p.text,
    thinking: p.thinking,
    usage: p.usage,
    turn: n,
  }, maxTokens)
  const t1 = await postProbeTurn({
    baseUrl: run.baseUrl,
    apiKey: run.apiKey,
    model: item.model,
    messages,
    maxTokens,
    sessionId: item.session_id,
    signal: run.abort.signal,
    timeoutMs: run.timeoutMs,
    onProgress: onTurn(1),
  })
  const turns = [{
    n: 1,
    ok: t1.ok,
    status: t1.status,
    text: t1.text || '',
    thinking: t1.thinking || '',
    usage: t1.usage,
    stop_reason: t1.stop_reason,
    raw: packProbeRaw(t1.request, t1),
  }]
  if (item.form === 'mixed' && t1.ok && !run.abort.signal.aborted) {
    messages.push(assistantMessage(t1))
    messages.push({ role: 'user', content: MIXED_FOLLOW })
    const t2 = await postProbeTurn({
      baseUrl: run.baseUrl,
      apiKey: run.apiKey,
      model: item.model,
      messages,
      maxTokens,
      sessionId: item.session_id,
      signal: run.abort.signal,
      timeoutMs: run.timeoutMs,
      onProgress: onTurn(2),
    })
    turns.push({
      n: 2,
      ok: t2.ok,
      status: t2.status,
      text: t2.text || '',
      thinking: t2.thinking || '',
      usage: t2.usage,
      stop_reason: t2.stop_reason,
      raw: packProbeRaw(t2.request, t2),
    })
  }
  const scored = scoreForm(q, item.form, turns)
  const last = turns[turns.length - 1]
  item.http = last.status
  item.text = turns.map((t) => t.text).filter(Boolean).join('\n---\n')
  item.turns = turns
  item.usage = last.usage
  item.stop_reason = last.stop_reason
  item.exact = scored.exact
  item.reasoned = scored.reasoned
  item.ok = scored.ok
  item.anomalies = scored.anomalies
  item.answer = scored.answer
  item.preview = clip(item.text)
  item.thinking = turns.map((t) => t.thinking || '').filter(Boolean).join('\n---\n')
  item.raw = { turns: turns.map((t) => t.raw) }
  attachStream(item, {
    phase: 'done',
    chars: item.text.length,
    thinking_chars: String(item.thinking || '').length,
    tokens_out: Number(last.usage?.output_tokens) || 0,
    turn: last.n,
  }, maxTokens)
  if (!t1.ok) item.error = String(t1.body?.error?.message || `status ${t1.status}`).slice(0, 400)
  item.status = run.abort.signal.aborted ? 'cancelled' : (t1.ok ? 'ok' : 'error')
}

async function runQueue(run) {
  const pending = run.items.filter((x) => x.status === 'pending')
  let cursor = 0
  const workers = Array.from({ length: run.concurrency }, async () => {
    while (true) {
      if (run.abort.signal.aborted) return
      const idx = cursor++
      if (idx >= pending.length) return
      if (idx > 0) {
        try { await sleep(400, run.abort.signal) } catch { return }
      }
      const item = pending[idx]
      item.status = 'running'
      const started = Date.now()
      try {
        if (item.suite === 'forms') await runOneForm(run, item)
        else await runOneCapability(run, item)
      } catch (e) {
        item.status = 'error'
        item.error = String(e.message || e).slice(0, 400)
        item.anomalies = ['http']
      } finally {
        item.duration_ms = Date.now() - started
      }
    }
  })
  await Promise.all(workers)
  if (run.abort.signal.aborted) {
    for (const item of run.items) {
      if (item.status === 'pending' || item.status === 'running') {
        item.status = 'cancelled'
        item.error = item.error || 'cancelled'
        if (!item.raw) {
          item.raw = packProbeRaw(
            { model: item.model, messages: [], stream: true },
            { ok: false, status: 0, headers: {}, body: { error: { type: 'cancelled', message: item.error } }, events: [], event_count: 0 },
          )
        }
      }
    }
  }
}

export function startProbeTest(opts = {}) {
  if (isTestJobBusy()) {
    return { ok: false, error: { code: 'run_in_progress', message: busyMessage() }, data: getTestJob() }
  }
  const suite = ['capability', 'forms', 'all'].includes(opts.suite) ? opts.suite : 'capability'
  const built = buildJobs({ ...opts, suite })
  if (!built.jobs.length) {
    return { ok: false, error: { code: 'empty', message: '没有可跑的用例' } }
  }
  const apiKey = opts.apiKey
  if (!apiKey) return { ok: false, error: { code: 'missing_api_key', message: 'gateway master key missing' } }
  const ceiling = Number(opts.max_tokens)
  const maxTokens = Number.isFinite(ceiling) && ceiling > 0
    ? Math.min(ABSOLUTE_MAX_TOKENS, Math.max(1, Math.floor(ceiling)))
    : ABSOLUTE_MAX_TOKENS
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 1))
  const id = `pr_${Date.now().toString(16)}_${crypto.randomBytes(3).toString('hex')}`
  const lock = beginTestJob('probe', id)
  if (!lock.ok) {
    return { ok: false, error: { code: 'run_in_progress', message: busyMessage(lock.current) }, data: lock.current }
  }
  const items = built.jobs.map((job, i) => ({
    id: `${id}_${i + 1}`,
    session_id: crypto.randomUUID(),
    status: 'pending',
    http: 0,
    exact: false,
    reasoned: job.suite !== 'forms' ? true : job.form === 'answer',
    ok: false,
    anomalies: [],
    stop_reason: null,
    duration_ms: 0,
    usage: null,
    preview: '',
    text: '',
    error: null,
    answer: null,
    turns: [],
    ...job,
  }))
  const run = {
    id,
    suite,
    status: 'running',
    started_at: nowIso(),
    finished_at: null,
    duration_ms: 0,
    models: built.models,
    forms: suite === 'capability' ? [] : (opts.forms || FORM_KINDS.map((f) => f.id)),
    questions: suite === 'capability' ? [] : (built.pick?.items || []).map((q) => q.id),
    sample: (suite === 'forms' ? built.pick?.sample : built.capPick?.sample) ?? null,
    seed: (suite === 'forms' ? built.pick?.seed : built.capPick?.seed) ?? null,
    random: (suite === 'forms' ? built.pick?.random : built.capPick?.random) ?? null,
    bank: suite === 'forms' ? (built.pick?.bank ?? FORM_QUESTIONS.length) : (built.capPick?.bank ?? CAPABILITY_CASES.length),
    cases: suite === 'forms' ? [] : (built.capPick?.items || []).map((c) => c.id),
    max_tokens: maxTokens,
    concurrency,
    timeoutMs: Math.max(30000, Math.min(600000, Number(opts.timeout_ms) || 240000)),
    baseUrl: String(opts.baseUrl || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    apiKey,
    dataDir: opts.dataDir || null,
    abort: new AbortController(),
    error: null,
    items,
  }
  runs.set(id, run)
  lastId = id
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value
    if (oldest === id) break
    runs.delete(oldest)
  }
  const started = Date.now()
  runQueue(run)
    .then(() => {
      if (run.abort.signal.aborted) run.status = 'cancelled'
      else if (run.items.every((x) => x.status === 'ok')) run.status = 'ok'
      else run.status = 'error'
    })
    .catch((e) => {
      run.status = 'error'
      run.error = String(e.message || e).slice(0, 400)
    })
    .finally(() => {
      run.finished_at = nowIso()
      run.duration_ms = Date.now() - started
      endTestJob(id)
      persistRun(run)
    })
  return { ok: true, data: publicRun(run) }
}

export function getProbeTest(id, { includeText = false } = {}) {
  if (id) return publicRun(runs.get(id) || null, { includeText })
  if (lastId && runs.has(lastId)) return publicRun(runs.get(lastId), { includeText })
  const last = [...runs.values()].at(-1)
  return publicRun(last || null, { includeText })
}

export function listProbeTests() {
  return [...runs.values()].map((r) => publicRun(r)).reverse()
}

export function cancelProbeTest(id) {
  const run = runs.get(id) || (lastId ? runs.get(lastId) : null)
  if (!run) return { ok: false, error: { code: 'not_found', message: 'no run' } }
  if (run.status === 'running') {
    run.abort.abort()
    run.status = 'cancelling'
    markTestJob(run.id, 'cancelling')
  }
  return { ok: true, data: publicRun(run) }
}

export { isTestJobBusy, getTestJob }
