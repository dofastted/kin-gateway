import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCrsUnofficialPersona, isOfficialClaudeCodeTraffic, CRS_OFFICIAL_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { storeAccountHeaders, resolveCrsHeaders } from '../../src/lib/identity/crs-headers.mjs'
import { sanitizeInboundBody, defaultSeedPolicy } from '../../src/lib/protocol/seed-policy.mjs'
import { prepareOutboundAttempt, prepareOutboundHeaders } from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  CLAUDE_CLI_UA,
  LOADTEST_UA,
  claudeCodeInboundBody,
  claudeCodeInboundHeaders,
  isLoadtestUa,
} from '../../src/lib/protocol/claude-code-inbound.mjs'
import { buildProbeTurnRequest } from '../../src/lib/admin/probe-test.mjs'
import { buildVmTestInbound } from '../../src/lib/admin/vm-test-chat.mjs'
import { TEST_UA, buildLoadtestTurnRequest } from '../../src/lib/admin/concurrent-test.mjs'
import { classifyClient } from '../../src/lib/protocol/client-fingerprint.mjs'

function fixtureIdentity(homeDir) {
  return {
    vmId: 'vm-01',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    userAgent: CLAUDE_CLI_UA,
    fingerprint: {
      x_app: 'cli',
      stainless_lang: 'js',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
      stainless_runtime: 'node',
      stainless_runtime_version: 'v24.3.0',
      stainless_package_version: '0.112.1',
    },
    homeDir,
  }
}

function seedStoredOfficial(homeDir) {
  storeAccountHeaders(homeDir, {
    'user-agent': CLAUDE_CLI_UA,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,prompt-caching-scope-2025-01-01',
    'x-app': 'cli',
    'x-stainless-os': 'Linux',
  })
}

test('probe inbound is official Claude Code, not a third-party UA', () => {
  const { body, headers } = buildProbeTurnRequest({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '86.4' }],
    maxTokens: 4096,
    sessionId: 'sess-probe-1',
  })
  assert.equal(headers['user-agent'], CLAUDE_CLI_UA)
  assert.equal(isLoadtestUa(headers['user-agent']), false)
  assert.equal(headers['anthropic-beta'], undefined)
  assert.equal(headers['x-app'], 'cli')
  assert.equal(body.system, CRS_OFFICIAL_SYSTEM)
  assert.ok(body.metadata?.user_id)
  assert.equal(isOfficialClaudeCodeTraffic(headers, body), true)
  assert.equal(classifyClient(headers, body), 'claude_code_official')
})

test('vm connectivity inbound matches probe Claude Code shape', () => {
  const { inbound, headers } = buildVmTestInbound({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    maxTokens: 8192,
    sessionId: 'vm-test-vm-01',
  })
  assert.equal(headers['user-agent'], CLAUDE_CLI_UA)
  assert.equal(headers['anthropic-beta'], undefined)
  assert.equal(inbound.system, CRS_OFFICIAL_SYSTEM)
  assert.equal(isOfficialClaudeCodeTraffic(headers, inbound), true)
})

test('loadtest inbound is third-party and must stay that way', () => {
  const { body, headers } = buildLoadtestTurnRequest({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: '研报 TSLA' }],
    maxTokens: 32000,
    sessionId: 'sess-lt-1',
    stream: true,
  })
  assert.equal(headers['user-agent'], TEST_UA)
  assert.equal(headers['user-agent'], LOADTEST_UA)
  assert.equal(isLoadtestUa(headers['user-agent']), true)
  assert.equal(isOfficialClaudeCodeTraffic(headers, body), false)
  assert.notEqual(classifyClient(headers, body), 'claude_code_official')
  assert.equal(body.system, undefined)
})

test('official UA without anthropic-beta does not overwrite stored CLI headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cc-store-'))
  seedStoredOfficial(dir)
  const before = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kin-cc-headers.json'), 'utf8'))
  const skipped = storeAccountHeaders(dir, claudeCodeInboundHeaders({ sessionId: 'x' }))
  assert.equal(skipped.stored, false)
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kin-cc-headers.json'), 'utf8'))
  assert.deepEqual(after.headers, before.headers)
  assert.match(String(after.headers['anthropic-beta'] || ''), /oauth-2025-04-20/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('probe and /v1 official applyAttempt emit the same outbound body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-out-'))
  const identity = fixtureIdentity(dir)
  const { body: inbound, headers } = buildProbeTurnRequest({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: '只写出 86.4' }],
    maxTokens: 4096,
    sessionId: 'sess-same',
  })
  const sanitized = sanitizeInboundBody(inbound, defaultSeedPolicy())
  // /v1 applyAttempt keeps the original inbound for identity, not the sanitized copy.
  const v1 = prepareOutboundAttempt({
    canonicalBody: sanitized,
    inbound,
    identity,
    unofficial: false,
    stream: true,
  })
  const probe = prepareOutboundAttempt({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    stream: true,
  })
  assert.deepEqual(probe.body, v1.body)
  assert.match(String(probe.body.system || ''), /You are Claude Code/)
  assert.equal(probe.body.stream, true)
  const v1Headers = prepareOutboundHeaders(headers, dir, identity, inbound.model)
  const probeHeaders = prepareOutboundHeaders(headers, dir, identity, inbound.model)
  assert.deepEqual(probeHeaders, v1Headers)
  assert.match(v1Headers['user-agent'], /^claude-cli\//)
  assert.doesNotMatch(v1Headers['user-agent'], /kin-console/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('vm-test-chat outbound equals /v1 official applyAttempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmout-'))
  const identity = fixtureIdentity(dir)
  const { inbound, headers } = buildVmTestInbound({
    model: 'claude-sonnet-5',
    prompt: 'hello',
    maxTokens: 8192,
    sessionId: 'vm-test-vm-01',
  })
  const fromHelper = prepareOutboundAttempt({
    canonicalBody: inbound,
    inbound,
    identity,
    unofficial: false,
    stream: true,
  })
  const fromV1 = prepareOutboundAttempt({
    canonicalBody: sanitizeInboundBody(inbound, defaultSeedPolicy()),
    inbound,
    identity,
    unofficial: false,
    stream: true,
  })
  assert.deepEqual(fromHelper.body, fromV1.body)
  const h1 = prepareOutboundHeaders(headers, dir, identity, inbound.model)
  const h2 = prepareOutboundHeaders(headers, dir, identity, inbound.model)
  assert.deepEqual(h1, h2)
  assert.match(h1['user-agent'], /^claude-cli\//)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadtest third-party goes through sanitization; outbound UA is still Claude Code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-lt-'))
  seedStoredOfficial(dir)
  const identity = fixtureIdentity(dir)
  const { body: inbound, headers } = buildLoadtestTurnRequest({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: '写一份 TSLA 研报' }],
    maxTokens: 32000,
    sessionId: 'sess-lt',
    stream: true,
  })
  const dirty = {
    ...inbound,
    settings: { theme: 'light' },
    user: 'attacker',
    metadata: { user_id: 'client-local', machine_id: 'host-a' },
  }
  const sanitized = sanitizeInboundBody(dirty, defaultSeedPolicy())
  assert.equal(sanitized.settings, undefined)
  assert.equal(sanitized.user, undefined)
  assert.equal(sanitized.metadata, undefined)
  const withPersona = applyCrsUnofficialPersona(sanitized, {
    officialClient: false,
    mode: 'append',
    headers,
  })
  assert.match(String(withPersona.system || ''), /You are Claude Code/)
  const outbound = prepareOutboundAttempt({
    canonicalBody: withPersona,
    inbound: sanitized,
    identity,
    unofficial: true,
    stream: true,
  })
  const outboundHeaders = prepareOutboundHeaders(headers, dir, identity, inbound.model)
  assert.match(outboundHeaders['user-agent'], /^claude-cli\//)
  assert.doesNotMatch(outboundHeaders['user-agent'], /kin-console-loadtest/)
  assert.match(String(outboundHeaders['anthropic-beta'] || ''), /oauth-2025-04-20/)
  assert.doesNotMatch(String(outboundHeaders['anthropic-beta'] || ''), /context-1m/)
  assert.equal(outbound.body.max_tokens, 32000)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('same identity + same messages: probe official and loadtest unofficial differ only by sanitization path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-diff-'))
  seedStoredOfficial(dir)
  const identity = fixtureIdentity(dir)
  const messages = [{ role: 'user', content: '圆周长 14' }]
  const probe = buildProbeTurnRequest({
    model: 'claude-sonnet-5',
    messages,
    maxTokens: 4096,
    sessionId: 's1',
  })
  const load = buildLoadtestTurnRequest({
    model: 'claude-sonnet-5',
    messages,
    maxTokens: 4096,
    sessionId: 's1',
    stream: true,
  })
  const probeOut = prepareOutboundAttempt({
    canonicalBody: probe.body,
    inbound: probe.body,
    identity,
    unofficial: false,
    stream: true,
  })
  const loadPersona = applyCrsUnofficialPersona(sanitizeInboundBody(load.body, defaultSeedPolicy()), {
    officialClient: false,
    mode: 'append',
    headers: load.headers,
  })
  const loadOut = prepareOutboundAttempt({
    canonicalBody: loadPersona,
    inbound: load.body,
    identity,
    unofficial: true,
    stream: true,
  })
  const probeH = prepareOutboundHeaders(probe.headers, dir, identity, 'claude-sonnet-5')
  const loadH = prepareOutboundHeaders(load.headers, dir, identity, 'claude-sonnet-5')
  assert.equal(probeH['user-agent'], loadH['user-agent'])
  assert.match(probeH['user-agent'], /^claude-cli\//)
  assert.equal(probeOut.body.model, loadOut.body.model)
  assert.ok(probeOut.body.system)
  assert.ok(loadOut.body.system)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('resolveCrsHeaders unofficial never leaks loadtest UA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ua-'))
  const identity = fixtureIdentity(dir)
  const leaked = resolveCrsHeaders({
    'user-agent': LOADTEST_UA,
    'anthropic-version': '2023-06-01',
  }, dir, identity, 'claude-sonnet-5')
  assert.notEqual(leaked['user-agent'], LOADTEST_UA)
  assert.match(leaked['user-agent'], /^claude-cli\//)
  fs.rmSync(dir, { recursive: true, force: true })
})
