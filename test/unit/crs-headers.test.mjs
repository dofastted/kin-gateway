import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractClaudeCodeHeaders, resolveCrsHeaders, isOfficialClaudeUa } from '../../src/lib/identity/crs-headers.mjs'

test('does not keep authorization or x-api-key', () => {
  const h = extractClaudeCodeHeaders({
    authorization: 'Bearer secret',
    'x-api-key': 'sk-ant',
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
    'anthropic-version': '2023-06-01',
  })
  assert.equal(h.authorization, undefined)
  assert.equal(h['x-api-key'], undefined)
  assert.equal(h['user-agent'].startsWith('claude-cli/'), true)
})

test('unofficial UA replays stored official headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-h-'))
  resolveCrsHeaders({
    'user-agent': 'claude-cli/2.1.234 (external, sdk-cli)',
    'x-stainless-os': 'Linux',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  }, dir)
  const replayed = resolveCrsHeaders({ 'user-agent': 'python-requests/2.24.0' }, dir)
  assert.equal(replayed['user-agent'].startsWith('claude-cli/'), true)
  assert.equal(isOfficialClaudeUa('python-requests/2.24.0'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official sonnet-5 keeps context-1m; others and unofficial drop it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-1m-'))
  const officialSonnet = resolveCrsHeaders({
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
    'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
  }, dir, null, 'claude-sonnet-5')
  assert.match(String(officialSonnet['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  const officialOpus = resolveCrsHeaders({
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
    'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
  }, dir, null, 'claude-opus-5')
  assert.doesNotMatch(String(officialOpus['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  const unofficial = resolveCrsHeaders({
    'user-agent': 'RikkaHub/1.0',
    'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
  }, dir, null, 'claude-sonnet-5')
  assert.doesNotMatch(String(unofficial['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  fs.rmSync(dir, { recursive: true, force: true })
})
