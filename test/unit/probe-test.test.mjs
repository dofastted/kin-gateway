import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stripFences,
  parseJsonLoose,
  classifyAnomalies,
  answersMatch,
  hasReasoningText,
  scoreCapability,
  scoreForm,
  buildNeedleFiller,
  CAPABILITY_CASES,
  FORM_QUESTIONS,
  getProbeCatalog,
  pickFormQuestions,
  pickCapabilityCases,
  sanitizeProbeHeaders,
  packProbeRaw,
} from '../../src/lib/admin/probe-test.mjs'

test('capability catalog has five ordinary cases and no training wording', () => {
  const cat = getProbeCatalog()
  assert.deepEqual(cat.suites.map((s) => s.id), ['capability', 'forms'])
  assert.equal(CAPABILITY_CASES.length, 5)
  const blob = JSON.stringify(CAPABILITY_CASES) + JSON.stringify(FORM_QUESTIONS)
  assert.doesNotMatch(blob, /蒸馏|教师|学生|训练集|distill|teacher model|student model/i)
  for (const c of CAPABILITY_CASES) {
    assert.doesNotMatch(c.user, /蒸馏|教师|学生|probe|injection/i)
  }
})

test('needle plants both codes inside a long ledger', () => {
  const n = buildNeedleFiller(8000)
  assert.match(n.text, /ALPHA-CODE: Q7-MINT/)
  assert.match(n.text, /OMEGA-CODE: Z9-PLUM/)
  assert.ok(n.chars >= 8000)
  assert.deepEqual(n.gold, { alpha: 'Q7-MINT', omega: 'Z9-PLUM' })
})

test('json gold matches fenced or compact text', () => {
  const caze = CAPABILITY_CASES.find((c) => c.id === 'spatial')
  const fenced = scoreCapability(caze, {
    ok: true,
    status: 200,
    text: '```json\n{\n  "top_left": "red",\n  "bottom_right": "yellow"\n}\n```',
    usage: { output_tokens: 24 },
    stop_reason: 'end_turn',
  })
  assert.equal(fenced.exact, true)
  const compact = scoreCapability(caze, {
    ok: true,
    status: 200,
    text: '{"top_left":"red","bottom_right":"yellow"}',
    usage: { output_tokens: 20 },
    stop_reason: 'end_turn',
  })
  assert.equal(compact.exact, true)
  const wrong = scoreCapability(caze, {
    ok: true,
    status: 200,
    text: '{"top_left":"blue","bottom_right":"yellow"}',
    usage: { output_tokens: 20 },
    stop_reason: 'end_turn',
  })
  assert.equal(wrong.exact, false)
  assert.ok(wrong.anomalies.includes('mismatch'))
})

test('follow accepts exact canary and rejects extras', () => {
  const caze = CAPABILITY_CASES.find((c) => c.id === 'follow')
  assert.equal(scoreCapability(caze, { ok: true, status: 200, text: 'BEGIN-09D0CECA-END', usage: {}, stop_reason: 'end_turn' }).exact, true)
  assert.equal(scoreCapability(caze, { ok: true, status: 200, text: 'OK BEGIN-09D0CECA-END', usage: {}, stop_reason: 'end_turn' }).exact, false)
})

test('thinking-only max_tokens is truncated + empty', () => {
  const a = classifyAnomalies({
    ok: true,
    status: 200,
    text: '',
    usage: { output_tokens: 900, output_tokens_details: { thinking_tokens: 900 } },
    stop_reason: 'max_tokens',
  })
  assert.deepEqual(a.sort(), ['empty', 'thinking_only', 'truncated'])
})

test('numbers gold is internally consistent', () => {
  const gold = CAPABILITY_CASES.find((c) => c.id === 'numbers').gold
  assert.equal(125 * 98 + 280, gold.arithmetic)
  assert.equal((7 ** 8) % 1000, gold.modular)
  assert.equal(gold.crt, 23)
  assert.equal((2026).toString(2).replace(/0/g, '').length, gold.binary_count)
  assert.equal('bDrK-47a'.split('').reverse().join(''), gold.reverse)
})

test('form scoring: answer / reason / mixed', () => {
  const q = FORM_QUESTIONS[0]
  const ans = scoreForm(q, 'answer', [{ text: '86.4', ok: true, status: 200 }])
  assert.equal(ans.exact, true)
  assert.equal(ans.ok, true)

  const reason = scoreForm(q, 'reason', [{
    text: '先按 20% 利润定价得到 96 元，再打 9 折。\n最终答案：86.4',
    ok: true,
    status: 200,
  }])
  assert.equal(reason.exact, true)
  assert.equal(reason.reasoned, true)

  const mixed = scoreForm(q, 'mixed', [
    { text: '86.4', ok: true, status: 200 },
    { text: '进价 80，加价 20% 得 96，再乘 0.9。\n最终答案：86.4', ok: true, status: 200 },
  ])
  assert.equal(mixed.exact, true)
  assert.equal(mixed.reasoned, true)

  const noStep = scoreForm(q, 'reason', [{ text: '最终答案：86.4', ok: true, status: 200 }])
  assert.equal(noStep.exact, true)
  assert.equal(noStep.reasoned, false)
  assert.ok(noStep.anomalies.includes('no_reason'))
})

test('capability sample picks one case when asked', () => {
  const one = pickCapabilityCases({ sample: 1, seed: 7, random: true })
  assert.equal(one.items.length, 1)
  assert.equal(one.bank, 5)
  const again = pickCapabilityCases({ sample: 1, seed: 7, random: true })
  assert.equal(again.items[0].id, one.items[0].id)
  const all = pickCapabilityCases({ random: false })
  assert.equal(all.items.length, 5)
})

test('form bank random pick is seeded and smaller than the bank', () => {
  assert.ok(FORM_QUESTIONS.length >= 20)
  const a = pickFormQuestions({ sample: 4, seed: 42, random: true })
  const b = pickFormQuestions({ sample: 4, seed: 42, random: true })
  const c = pickFormQuestions({ sample: 4, seed: 99, random: true })
  assert.equal(a.sample, 4)
  assert.equal(a.items.length, 4)
  assert.deepEqual(a.items.map((q) => q.id), b.items.map((q) => q.id))
  assert.notEqual(a.items.map((q) => q.id).join(','), c.items.map((q) => q.id).join(','))
  const sequential = pickFormQuestions({ sample: 4, random: false })
  assert.deepEqual(sequential.items.map((q) => q.id), ['q1', 'q2', 'q3', 'q4'])
})

test('meeting hour accepts 18/7', () => {
  const q = FORM_QUESTIONS[1]
  assert.equal(scoreForm(q, 'answer', [{ text: '18/7', ok: true, status: 200 }]).exact, true)
  assert.equal(scoreForm(q, 'answer', [{ text: '最终答案：2.57 小时', ok: true, status: 200 }]).exact, true)
})

test('raw pack redacts secrets and keeps response body', () => {
  const raw = packProbeRaw(
    { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    {
      ok: true,
      status: 200,
      headers: { authorization: 'Bearer secret', 'content-type': 'text/event-stream', 'x-api-key': 'nope' },
      stop_reason: 'end_turn',
      usage: { output_tokens: 12 },
      body: { content: [{ type: 'text', text: 'BEGIN-09D0CECA-END' }] },
      events: [{ t: 10, type: 'message_start' }],
      event_count: 4,
    },
  )
  assert.equal(raw.request.model, 'claude-haiku-4-5')
  assert.equal(raw.response.status, 200)
  assert.equal(raw.response.headers['content-type'], 'text/event-stream')
  assert.equal(raw.response.headers.authorization, undefined)
  assert.equal(raw.response.headers['x-api-key'], undefined)
  assert.equal(sanitizeProbeHeaders({ Cookie: 'a=1' }).cookie, undefined)
  assert.equal(raw.stream.event_count, 4)
})

test('helpers: fences and json', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}')
  assert.deepEqual(parseJsonLoose('x {"a":1} y'), { a: 1 })
  assert.equal(hasReasoningText('短'), false)
  assert.equal(hasReasoningText('第一步先算进价加价\n第二步再打折\n因此得到结果'), true)
  assert.equal(answersMatch('{"alpha":"Q7-MINT","omega":"Z9-PLUM"}', { alpha: 'Q7-MINT', omega: 'Z9-PLUM' }), true)
})
