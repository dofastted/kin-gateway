import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, takeTrace, listCaptures } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'
const HERMES_SYS = [
  'You are Hermes, a Nous Research agent.',
  'SOUL.md identity.',
  '<available_skills>',
  '- web',
  '</available_skills>',
].join('\n')

test('Hermes UA + system: classified, tools kept, client workspace hop', async () => {
  const gw = await startGateway({ diffCapture: '1', mockText: 'pong' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'user-agent': 'hermes-agent/0.13.0' },
      body: {
        model: MODEL,
        max_tokens: 32,
        system: HERMES_SYS,
        extra_body: { should_drop: true },
        tools: [{
          name: 'read_file',
          description: 'hermes read',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        }],
        messages: [{ role: 'user', content: 'say pong' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const text = (r.json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    assert.match(text, /pong/)

    const tr = takeTrace(gw)
    assert.ok(tr)
    const sys = tr.argv[tr.argv.indexOf('--append-system-prompt') + 1] || ''
    assert.match(sys, /You are Hermes/)
    assert.ok(tr.argv.includes('--allowedTools'))
    const allow = tr.argv[tr.argv.indexOf('--allowedTools') + 1] || ''
    assert.match(allow, /mcp__kinclient__read_file/)
    assert.equal(tr.argv[tr.argv.indexOf('--permission-mode') + 1], 'default')

    const diffs = listCaptures(gw).filter((c) => c.client_class)
    assert.ok(diffs.some((c) => c.client_class === 'hermes'), JSON.stringify(diffs.map((c) => c.client_class)))
    assert.ok(diffs.some((c) => c.has_tools === true))
  } finally {
    await gw.stop()
  }
})

test('Hermes system blob without UA still classifies as hermes', async () => {
  const gw = await startGateway({ diffCapture: '1' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: {
        model: MODEL,
        max_tokens: 8,
        system: 'You are Hermes\nSOUL.md\nNous Research',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    assert.equal(r.status, 200, r.text)
    const diffs = listCaptures(gw).filter((c) => c.client_class)
    assert.ok(diffs.some((c) => c.client_class === 'hermes'))
  } finally {
    await gw.stop()
  }
})
