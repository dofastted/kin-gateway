import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTINUE_USER_TEXT,
  MISSING_TOOL_RESULT_TEXT,
  ensureConversationEndsWithUser,
  ensureOutputConfigSchema,
  pairMissingToolResults,
  rectifyUnofficialRequest,
  rectifyUnofficialRequestForRetry,
} from '../../src/lib/protocol/request-rectifier.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'

test('assistant prefill gets a trailing user turn', () => {
  const body = ensureConversationEndsWithUser({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  })
  assert.equal(body.messages.at(-1).role, 'user')
  assert.equal(body.messages.at(-1).content[0].text, CONTINUE_USER_TEXT)
})

test('unpaired tool_use gets a placeholder tool_result', () => {
  const body = pairMissingToolResults({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }],
      },
    ],
  })
  assert.equal(body.messages.at(-1).role, 'user')
  assert.equal(body.messages.at(-1).content[0].type, 'tool_result')
  assert.equal(body.messages.at(-1).content[0].tool_use_id, 'toolu_1')
  assert.equal(body.messages.at(-1).content[0].content, MISSING_TOOL_RESULT_TEXT)
})

test('output_config object schema gets additionalProperties=false', () => {
  const body = ensureOutputConfigSchema({
    output_config: {
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    },
  })
  assert.equal(body.output_config.format.schema.additionalProperties, false)
})

test('unofficial first pass does not invent continue or dummy tool_result', () => {
  const raw = {
    model: 'claude-sonnet-5',
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prefill' }] },
    ],
  }
  const unofficial = prepareAnthropicRequest(raw, { unofficial: true })
  assert.equal(unofficial.messages.at(-1).role, 'assistant')
  const official = prepareAnthropicRequest(raw, { unofficial: false })
  assert.equal(official.messages.at(-1).role, 'assistant')
})

test('short thinking signatures are stripped as truncated', () => {
  const body = prepareAnthropicRequest({
    model: 'claude-opus-5',
    thinking: { type: 'adaptive' },
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'keep', signature: 'too_short' },
        { type: 'text', text: 'answer' },
      ],
    }],
  })
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'answer' }])
})

test('rectifyUnofficialRequest first pass leaves assistant tool_use alone', () => {
  const body = rectifyUnofficialRequest({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_x', name: 'x', input: {} },
        { type: 'text', text: 'done' },
      ],
    }],
  })
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'assistant')
})

test('retry rectifier pairs tools then ends on user', () => {
  const body = rectifyUnofficialRequestForRetry({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_x', name: 'x', input: {} },
        { type: 'text', text: 'done' },
      ],
    }],
  })
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[1].role, 'user')
  assert.equal(body.messages[1].content[0].tool_use_id, 'toolu_x')
})
