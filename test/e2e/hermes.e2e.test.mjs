import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace, listCaptures } from '../harness.mjs'
import { CRS_OFFICIAL_SYSTEM } from '../../src/lib/crs-persona.mjs'

const MODEL = 'claude-haiku-4-5-20251001'
const HERMES_SYS = [
  'You are Hermes, a Nous Research agent.',
  'SOUL.md identity.',
  '<available_skills>',
  '- web',
  '</available_skills>',
].join('\n')

test('Hermes unofficial: CRS relay, official persona, tools kept, no CLI argv', async () => {
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

    const tr = readTrace(gw)
    assert.equal(tr?.via, 'crs-relay')
    assert.match(String(tr?.system || ''), /You are Hermes/)
    assert.match(String(tr?.system || ''), /Claude Code/)
    assert.ok(tr?.tools.includes('read_file'))
    assert.ok(!tr?.argv)

    const diffs = listCaptures(gw).filter((c) => c.client_class)
    assert.ok(diffs.some((c) => c.client_class === 'hermes'), JSON.stringify(diffs.map((c) => c.client_class)))
    assert.ok(diffs.some((c) => c.has_tools === true))
    assert.ok(diffs.some((c) => c.via === 'crs-relay'))
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
    const tr = readTrace(gw)
    assert.equal(tr?.via, 'crs-relay')
    assert.match(String(tr?.system || ''), /You are Hermes/)
    assert.match(String(tr?.system || ''), /Claude Code/)
  } finally {
    await gw.stop()
  }
})
