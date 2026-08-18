import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStreamJsonTurns,
  toAnthropicBlocks,
  openAiImageToAnthropic,
  buildHopArgs,
} from './client-cli-hop.mjs'

function parseLines(r) {
  return r.lines.map((l) => JSON.parse(l))
}

// ---------- image normalization (T3) ----------
test('openAiImageToAnthropic: data URL → base64 source', () => {
  const b = openAiImageToAnthropic('data:image/png;base64,AAAA')
  assert.equal(b.type, 'image')
  assert.equal(b.source.type, 'base64')
  assert.equal(b.source.media_type, 'image/png')
  assert.equal(b.source.data, 'AAAA')
})

test('openAiImageToAnthropic: http URL → url source', () => {
  const b = openAiImageToAnthropic('https://x/y.png')
  assert.equal(b.source.type, 'url')
  assert.equal(b.source.url, 'https://x/y.png')
})

test('toAnthropicBlocks preserves text + image + tool_result', () => {
  const blocks = toAnthropicBlocks([
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZZZ' } },
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
  ])
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].source.type, 'base64')
  assert.equal(blocks[2].type, 'tool_result')
})

// ---------- multi-turn history (T2) ----------
test('single turn: sends native user blocks, no transcript wrapper', () => {
  const r = buildStreamJsonTurns([{ role: 'user', content: 'hello world' }])
  const [line] = parseLines(r)
  assert.equal(line.type, 'user')
  assert.deepEqual(line.message.content, [{ type: 'text', text: 'hello world' }])
  assert.equal(r.meta.history_flattened, false)
  assert.equal(r.meta.turns, 1)
})

test('multi-turn: prior turns preserved as transcript, trailing native', () => {
  const r = buildStreamJsonTurns([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ])
  const [line] = parseLines(r)
  assert.equal(r.meta.history_flattened, true)
  const text = JSON.stringify(line.message.content)
  // history retained (not dropped like the old lastUserText)
  assert.match(text, /first question/)
  assert.match(text, /first answer/)
  assert.match(text, /second question/)
})

test('multi-turn: latest image survives as native block', () => {
  const r = buildStreamJsonTurns([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG' } },
    ] },
  ])
  const [line] = parseLines(r)
  const imgs = line.message.content.filter((b) => b.type === 'image')
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].source.data, 'IMG')
  assert.equal(r.meta.had_images, true)
})

test('resume: only trailing turn sent (history via --resume)', () => {
  const r = buildStreamJsonTurns([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old-ans' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
  ], { resumeSessionId: 'sess-1' })
  const [line] = parseLines(r)
  assert.equal(r.lines.length, 1)
  const text = JSON.stringify(line.message.content)
  assert.doesNotMatch(text, /old-ans/)
  assert.match(text, /tool_result/)
  assert.equal(r.meta.had_tool_results, true)
})

test('empty messages → Hello fallback', () => {
  const r = buildStreamJsonTurns([])
  const [line] = parseLines(r)
  assert.deepEqual(line.message.content, [{ type: 'text', text: 'Hello' }])
})

test('OpenAI assistant tool_calls + tool role are preserved across hop lines (CLI fallback)', () => {
  const r = buildStreamJsonTurns([
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"path":"/x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file body' },
    { role: 'user', content: 'thanks' },
  ])
  const blob = r.lines.join('\n')
  assert.match(blob, /tool_use/)
  assert.match(blob, /mcp__kinclient__Read|Read/)
  assert.match(blob, /file body/)
})

// ---------- args: fail-closed perms (T5) ----------
test('buildHopArgs: fail-closed permission mode, denies built-ins', () => {
  const { args } = buildHopArgs({ mdl: 'claude-x', mcpCfg: '/tmp/m.json', tools: [], body: {}, resumeSessionId: null })
  const i = args.indexOf('--permission-mode')
  assert.equal(args[i + 1], 'default')
  assert.ok(!args.includes('bypassPermissions'))
  const d = args.indexOf('--disallowedTools')
  assert.match(args[d + 1], /Bash/)
  assert.match(args[d + 1], /MultiEdit/)
  // no client tools → no allowlist entry
  assert.ok(!args.includes('--allowedTools'))
})

test('buildHopArgs: client tools become mcp allowlist entries', () => {
  const { args } = buildHopArgs({ mdl: 'm', mcpCfg: '/tmp/m.json', tools: [{ name: 'Read' }, { function: { name: 'Grep' } }], body: {}, resumeSessionId: null })
  const a = args.indexOf('--allowedTools')
  assert.ok(a > -1)
  assert.equal(args[a + 1], 'mcp__kinclient__Read,mcp__kinclient__Grep')
})

// ---------- args: CLI fallback does not truncate official system ----------
test('buildHopArgs: official system is passthrough, not truncated', () => {
  const big = 'x'.repeat(30000)
  const { args, sysMeta } = buildHopArgs({ mdl: 'm', mcpCfg: '/tmp/m.json', tools: [], body: { system: big }, resumeSessionId: null })
  assert.equal(sysMeta.truncated, false)
  assert.equal(sysMeta.passthrough, true)
  assert.equal(sysMeta.orig_len, 30000)
  const s = args.indexOf('--system-prompt')
  assert.ok(s > -1)
  assert.equal(args[s + 1].length, 30000)
})

// ---------- args: param mapping (T4) ----------
test('buildHopArgs: unmappable params recorded, thinking budget mapped', () => {
  const { paramMeta } = buildHopArgs({
    mdl: 'm', mcpCfg: '/tmp/m.json', tools: [], resumeSessionId: null,
    body: { max_tokens: 1000, temperature: 0.5, thinking: { type: 'enabled', budget_tokens: 4096 } },
  })
  assert.ok(paramMeta.dropped.includes('max_tokens'))
  assert.ok(paramMeta.dropped.includes('temperature'))
  assert.equal(paramMeta.thinking_budget, 4096)
})
