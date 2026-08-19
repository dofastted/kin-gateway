import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toClaudeMessages,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  createResponsesStreamState,
  claudeSSELineToResponsesEvents,
  createOpenAICompletionStreamState,
  claudeSSELineToOpenAICompletionChunks,
} from '../../src/lib/protocol/convert.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

const PRETTY_SSE = [
  'event: message_start',
  'data: {',
  '  "type": "message_start",',
  '  "message": { "id": "msg_1", "model": "claude-sonnet-5", "type": "message" }',
  '}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {',
  '  "type": "content_block_delta",',
  '  "index": 0,',
  '  "delta": { "type": "text_delta", "text": "pong" }',
  '}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
]

function collect(fn, state, lines) {
  const out = []
  for (const line of lines) out.push(...fn(line, state))
  return out
}

test('openai.chat convert copies stream:true onto Claude body', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(claude.stream, true)
  const official = officialMessagesBody(claude, { stream: true })
  assert.equal(official.stream, true)
})

test('openai.chat convert omits stream when inbound is not streaming', () => {
  const { claude } = toClaudeMessages('openai.chat', {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(claude.stream, undefined)
})

test('openai.responses and openai.completions copy stream:true', () => {
  const responses = toClaudeMessages('openai.responses', {
    model: MODEL,
    stream: true,
    input: 'hi',
  })
  assert.equal(responses.claude.stream, true)
  const completions = toClaudeMessages('openai.completions', {
    model: MODEL,
    stream: true,
    prompt: 'hi',
  })
  assert.equal(completions.claude.stream, true)
})

test('pretty-printed multiline Anthropic SSE converts to OpenAI chat chunks', () => {
  const state = createOpenAIChatStreamState(MODEL, 'vm-1')
  const chunks = collect(claudeSSELineToOpenAIChatChunks, state, PRETTY_SSE)
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.role === 'assistant'))
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.content === 'pong'))
  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason)
  assert.equal(finish.choices[0].finish_reason, 'stop')
  assert.equal(state.dataBuf, '')
})

test('compact single-line Anthropic SSE still converts', () => {
  const state = createOpenAIChatStreamState(MODEL, 'vm-1')
  const chunks = collect(claudeSSELineToOpenAIChatChunks, state, [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    '',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    '',
  ])
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.content === 'ok'))
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop')
})

test('pretty-printed SSE converts to Responses events', () => {
  const state = createResponsesStreamState(MODEL, 'vm-1')
  const events = collect(claudeSSELineToResponsesEvents, state, PRETTY_SSE)
  assert.ok(events.some((e) => e.type === 'response.created'))
  assert.ok(events.some((e) => e.type === 'response.output_text.delta' && e.delta === 'pong'))
  assert.ok(events.some((e) => e.type === 'response.completed'))
})

test('pretty-printed SSE converts to completion chunks', () => {
  const state = createOpenAICompletionStreamState(MODEL, 'vm-1')
  const chunks = collect(claudeSSELineToOpenAICompletionChunks, state, PRETTY_SSE)
  assert.ok(chunks.some((c) => c.choices?.[0]?.text === 'pong'))
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop')
})
