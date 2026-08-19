import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remapCodexTools, CODEX_TOOL_MAP } from '../../src/lib/codex-tools.mjs'
import { classifyClient } from '../../src/lib/client-fingerprint.mjs'

test('codex tool remap', () => {
  const out = remapCodexTools([{ name: 'apply_patch' }, { function: { name: 'read_file' } }])
  assert.equal(out[0].name, 'Bash')
  assert.equal(out[1].function.name, 'Read')
})

test('unknown tool names pass through unchanged', () => {
  const out = remapCodexTools([{ name: 'my_custom_tool' }, 'not-an-object'])
  assert.equal(out[0].name, 'my_custom_tool')
  assert.equal(out[1], 'not-an-object')
  assert.equal(remapCodexTools(null), null)
})

test('map covers plan/web tools', () => {
  assert.equal(CODEX_TOOL_MAP.update_plan, 'TodoWrite')
  assert.equal(CODEX_TOOL_MAP.web_fetch, 'WebFetch')
})

test('client classification', () => {
  assert.equal(classifyClient({ 'user-agent': 'hermes-agent/0.13.0' }, {}), 'hermes')
  assert.equal(
    classifyClient({ 'user-agent': 'node' }, { system: 'You are a personal assistant running inside OpenClaw.' }),
    'openclaw',
  )
  assert.equal(classifyClient({ 'user-agent': 'claude-cli/2.1.234' }, {}), 'claude_code_official')
  assert.equal(classifyClient({ 'user-agent': 'axios/1.6' }, {}), 'third_party')
})
