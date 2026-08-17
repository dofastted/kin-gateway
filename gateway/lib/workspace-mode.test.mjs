import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWorkspaceMode, requestNeedsClientTools } from './workspace-mode.mjs'

test('default workspace is client — VM tools are opt-in', () => {
  assert.equal(resolveWorkspaceMode({}, {}, 'claude_code_official'), 'client')
  assert.equal(resolveWorkspaceMode({ headers: {} }, {}, 'unknown'), 'client')
})

test('x-kin-workspace: vm opts into slot execution', () => {
  assert.equal(resolveWorkspaceMode({ headers: { 'x-kin-workspace': 'vm' } }, {}, ''), 'vm')
  assert.equal(resolveWorkspaceMode({ headers: { 'x-kin-workspace': 'client' } }, {}, ''), 'client')
})

test('requestNeedsClientTools detects tools and tool_result', () => {
  assert.equal(requestNeedsClientTools({ tools: [{ name: 'Read' }] }), true)
  assert.equal(requestNeedsClientTools({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }],
  }), true)
  assert.equal(requestNeedsClientTools({ messages: [{ role: 'user', content: 'hi' }] }), false)
})
