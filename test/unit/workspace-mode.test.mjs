import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveWorkspaceMode, isOfficialClaudeClient } from '../../src/lib/protocol/workspace-mode.mjs'

test('default workspace is client — VM tools are opt-in', () => {
  assert.equal(resolveWorkspaceMode({}, {}, 'claude_code_official'), 'client')
  assert.equal(resolveWorkspaceMode({ headers: {} }, {}, 'unknown'), 'client')
})

test('x-kin-workspace: vm opts into slot execution', () => {
  assert.equal(resolveWorkspaceMode({ headers: { 'x-kin-workspace': 'vm' } }, {}, ''), 'vm')
  assert.equal(resolveWorkspaceMode({ headers: { 'x-kin-workspace': 'client' } }, {}, ''), 'client')
})

test('isOfficialClaudeClient recognizes official client classes', () => {
  assert.equal(isOfficialClaudeClient('claude_code_official'), true)
  assert.equal(isOfficialClaudeClient('claude_official_cli'), true)
  assert.equal(isOfficialClaudeClient('unknown'), false)
})
