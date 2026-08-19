#!/usr/bin/env node
/**
 * Official `claude` CLI stand-in for simulation tests.
 * Speaks stream-json on stdout. Scenario via KIN_MOCK_SCENARIO.
 *
 * Quoted catalog ids below are scanned by harvestCliModelCatalog (readBinaryQuotedIds):
 * "claude-sonnet-4-6" "claude-opus-4-6" "claude-haiku-4-5-20251001"
 */
import fs from 'node:fs'

const CATALOG = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']
const argv = process.argv.slice(2)
const scenario = process.env.KIN_MOCK_SCENARIO || 'text'
const model = pickArg('--model') || 'claude-haiku-4-5-20251001'
const sessionId = process.env.KIN_MOCK_SESSION_ID || 'sess-mock-1'

function pickArg(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

function writeTrace() {
  const dest = process.env.KIN_MOCK_TRACE_FILE
  if (!dest) return
  let stdin = ''
  try { stdin = fs.readFileSync(0, 'utf8') } catch { stdin = '' }
  const payload = {
    argv,
    cwd: process.cwd(),
    env: {
      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || null,
      KIN_MOCK_SCENARIO: scenario,
      HOME: process.env.HOME || null,
    },
    stdin,
  }
  try {
    fs.mkdirSync(requireDir(dest), { recursive: true })
  } catch {}
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2))
  return stdin
}

function requireDir(file) {
  const i = file.lastIndexOf('/')
  return i >= 0 ? file.slice(0, i) : '.'
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function emitEvent(ev) {
  emit({ type: 'stream_event', event: ev })
}

function init() {
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model })
}

function textTurn(text) {
  init()
  emitEvent({
    type: 'message_start',
    message: { id: `msg_${sessionId}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null },
  })
  emitEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  emitEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  emitEvent({ type: 'content_block_stop', index: 0 })
  emitEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
  emitEvent({ type: 'message_stop' })
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  emit({
    type: 'result',
    result: text,
    session_id: sessionId,
    usage: { input_tokens: 12, output_tokens: 4 },
    is_error: false,
  })
}

function thinkingTurn() {
  init()
  emitEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  emitEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })
  emitEvent({ type: 'content_block_stop', index: 0 })
  emitEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
  emitEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'thoughtful-pong' } })
  emitEvent({ type: 'content_block_stop', index: 1 })
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'thoughtful-pong' }] } })
  emit({ type: 'result', result: 'thoughtful-pong', session_id: sessionId, usage: { input_tokens: 8, output_tokens: 6 } })
}

function toolUseTurn() {
  init()
  const tu = {
    type: 'tool_use',
    id: 'toolu_mock1',
    name: 'mcp__kinclient__read_file',
    input: { path: '/tmp/x' },
  }
  emitEvent({ type: 'content_block_start', index: 0, content_block: tu })
  emit({ type: 'assistant', message: { content: [tu] } })
}

function rateLimitTurn() {
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      rateLimitType: 'five_hour',
      status: 'allowed',
      resetsAt: 9999999999,
      overageStatus: 'rejected',
    },
  })
  textTurn('rate-ok')
}

async function main() {
  if (argv.includes('--version')) {
    process.stdout.write('2.1.233 (Claude Code)\n')
    return
  }
  if (argv.includes('auth') && argv.includes('status')) {
    process.stdout.write(JSON.stringify({
      loggedIn: true,
      authMethod: 'oauth',
      apiProvider: 'firstParty',
      email: 'fake-oauth@kin.test',
      orgId: 'org-fake-sim',
      orgName: 'KIN Sim',
      subscriptionType: 'pro',
    }) + '\n')
    return
  }
  if (argv.includes('--help')) {
    process.stdout.write(`mock-claude models: ${CATALOG.join(' ')}\n`)
    return
  }

  const stdin = writeTrace() || ''
  void stdin

  if (scenario === 'hang') {
    await new Promise((r) => setTimeout(r, 30_000))
    return
  }
  if (scenario === 'error') {
    process.stderr.write('mock-claude simulated failure\n')
    process.exitCode = 2
    emit({ type: 'error', error: { type: 'api_error', message: 'mock-claude simulated failure' } })
    return
  }
  if (scenario === 'tool_use') return toolUseTurn()
  if (scenario === 'thinking') return thinkingTurn()
  if (scenario === 'rate_limit') return rateLimitTurn()
  textTurn(process.env.KIN_MOCK_TEXT || 'pong')
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n')
  process.exit(1)
})
