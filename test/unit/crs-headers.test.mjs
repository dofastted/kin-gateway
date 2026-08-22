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
  assert.match(String(unofficial['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.match(String(unofficial['anthropic-beta'] || ''), /effort-2025-11-24/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official empty beta uses sub2api DefaultBetaHeader; unofficial uses full mimicry set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-def-'))
  const official = resolveCrsHeaders({
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
    'anthropic-version': '2023-06-01',
  }, dir, null, 'claude-sonnet-5')
  assert.match(String(official['anthropic-beta'] || ''), /claude-code-20250219/)
  assert.match(String(official['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.doesNotMatch(String(official['anthropic-beta'] || ''), /context-management-2025-06-27/)
  const haiku = resolveCrsHeaders({
    'user-agent': 'claude-cli/2.1.234 (external, cli)',
  }, dir, null, 'claude-haiku-4-5-20251001')
  assert.match(String(haiku['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.doesNotMatch(String(haiku['anthropic-beta'] || ''), /claude-code-20250219/)
  const unofficial = resolveCrsHeaders({ 'user-agent': 'RikkaHub/1.0' }, dir, null, 'claude-opus-5')
  assert.match(String(unofficial['anthropic-beta'] || ''), /claude-code-20250219/)
  assert.match(String(unofficial['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.doesNotMatch(String(unofficial['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('unofficial inbound two-token beta does not leak; UA is Claude Code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-leak-'))
  const identity = {
    userAgent: 'claude-cli/2.1.234 (external, cli)',
    fingerprint: {
      x_app: 'cli',
      stainless_lang: 'js',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
      stainless_runtime: 'node',
      stainless_runtime_version: 'v24.3.0',
      stainless_package_version: '0.112.1',
    },
  }
  const out = resolveCrsHeaders({
    'user-agent': 'Go-http-client/2.0',
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    'x-stainless-os': 'Windows',
  }, dir, identity, 'claude-fable-5')
  assert.match(out['user-agent'], /^claude-cli\//)
  assert.doesNotMatch(out['user-agent'], /Go-http-client/)
  assert.equal(out['x-stainless-os'], 'Linux')
  assert.match(String(out['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.match(String(out['anthropic-beta'] || ''), /context-management-2025-06-27/)
  const tokens = String(out['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  assert.ok(tokens.length >= 5)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('unofficial Haiku uses short beta set without context-management', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-haiku-'))
  const out = resolveCrsHeaders({
    'user-agent': 'Go-http-client/2.0',
    'anthropic-beta': 'claude-code-20250219,context-management-2025-06-27,effort-2025-11-24',
  }, dir, {
    userAgent: 'claude-cli/2.1.234 (external, cli)',
    fingerprint: { x_app: 'cli', stainless_os: 'Linux' },
  }, 'claude-haiku-4-5-20251001')
  assert.match(out['user-agent'], /^claude-cli\//)
  assert.match(String(out['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.doesNotMatch(String(out['anthropic-beta'] || ''), /context-management-2025-06-27/)
  assert.doesNotMatch(String(out['anthropic-beta'] || ''), /effort-2025-11-24/)
  assert.doesNotMatch(String(out['anthropic-beta'] || ''), /context-1m/)
  fs.rmSync(dir, { recursive: true, force: true })
})
