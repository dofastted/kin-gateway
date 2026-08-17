import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveClaudeLauncher, claudeSpawnSpec, shouldPrivdrop } from '../../lib/cli-launcher.mjs'

test('production hop argv snapshot: sudo -u kincli -E claude', () => {
  const env = {}
  const l = resolveClaudeLauncher({ style: 'hop' }, env)
  assert.equal(l.cmd, 'sudo')
  assert.deepEqual(l.argvPrefix, ['-u', 'kincli', '-E', 'claude'])
  assert.equal(l.privdrop, true)
  const spec = claudeSpawnSpec(['-p', '--model', 'x'], { style: 'hop', env })
  assert.deepEqual(spec.argv, ['-u', 'kincli', '-E', 'claude', '-p', '--model', 'x'])
})

test('production runner argv snapshot: sudo -u kincli -E -- claude', () => {
  const env = {}
  const l = resolveClaudeLauncher({ style: 'runner' }, env)
  assert.deepEqual(l.argvPrefix, ['-u', 'kincli', '-E', '--', 'claude'])
})

test('KIN_CLI_LAUNCHER=direct uses CLAUDE_CLI_PATH, no sudo', () => {
  const env = { KIN_CLI_LAUNCHER: 'direct', CLAUDE_CLI_PATH: '/opt/mock/claude' }
  const spec = claudeSpawnSpec(['-p'], { style: 'hop', env })
  assert.equal(spec.cmd, '/opt/mock/claude')
  assert.deepEqual(spec.argv, ['-p'])
  assert.equal(spec.privdrop, false)
  assert.equal(shouldPrivdrop(env), false)
})

test('KIN_DISABLE_PRIVDROP=1 also skips sudo', () => {
  const env = { KIN_DISABLE_PRIVDROP: '1', CLAUDE_CLI_PATH: '/bin/echo' }
  assert.equal(shouldPrivdrop(env), false)
  assert.equal(resolveClaudeLauncher({ style: 'runner' }, env).privdrop, false)
})

test('.mjs CLAUDE_CLI_PATH is launched via node', () => {
  const env = { KIN_CLI_LAUNCHER: 'direct', CLAUDE_CLI_PATH: '/tmp/mock-claude.mjs' }
  const spec = claudeSpawnSpec(['-p'], { style: 'hop', env })
  assert.equal(spec.cmd, process.execPath)
  assert.deepEqual(spec.argv, ['/tmp/mock-claude.mjs', '-p'])
})
