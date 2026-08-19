/**
 * Offline acceptance tests — no real OAuth keys, no api.anthropic.com.
 * Fixtures from gateway captures (redacted) + synthetic tools/metadata body.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { officialMessagesBody, callAnthropicMessages, streamAnthropicMessages } from '../../src/lib/protocol/anthropic-messages.mjs'
import { applyCrsIdentityReplace, IDENTITY_REPLACE } from '../../src/lib/identity/identity-rewrite.mjs'
import { resolveWorkspaceMode } from '../../src/lib/protocol/workspace-mode.mjs'
import { persistOauthToVm, normalizeOauth } from '../../src/lib/oauth/oauth-credentials.mjs'
import { formatMetadataUserId } from '../../src/lib/identity/vm-identity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, '..', 'fixtures')

function loadPkt(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'))
}

const VM_IDENTITY = {
  sessionId: 'vm-session-fixed',
  deviceId: 'b'.repeat(64),
  accountUuid: 'vm-account-uuid',
  metadataUserId: formatMetadataUserId({
    deviceId: 'b'.repeat(64),
    accountUuid: 'vm-account-uuid',
    sessionId: 'vm-session-fixed',
  }),
  settings: { theme: 'dark', env: { TZ: 'America/Los_Angeles' } },
  fingerprint: {
    user_agent: 'claude-cli/2.1.233 (external, cli)',
    stainless_lang: 'js',
    session_id: 'vm-session-fixed',
  },
  userAgent: 'claude-cli/2.1.233 (external, cli)',
}

// ---------- fixtures load ----------
test('fixtures: pkt-001/002/003 exist and have inbound_body', () => {
  for (const n of [
    'pkt-001-openai.chat.completions.json',
    'pkt-002-anthropic.messages.json',
    'pkt-003-openai.responses.json',
    'synth-tools-metadata.anthropic.json',
  ]) {
    const d = loadPkt(n)
    assert.ok(d.inbound_body || d.inbound_protocol, n)
  }
})

// ---------- protocol convert from captures ----------
test('pkt-001 openai.chat → Claude preserves user text', () => {
  const pkt = loadPkt('pkt-001-openai.chat.completions.json')
  const { claude } = toClaudeMessages('openai.chat', pkt.inbound_body, {})
  assert.ok(claude.messages?.length)
  const text = JSON.stringify(claude.messages)
  assert.match(text, /CAP_CHAT/)
  assert.ok(!('tools' in claude) || claude.tools === undefined || Array.isArray(claude.tools))
})

test('pkt-002 anthropic.messages passthrough preserves user text', () => {
  const pkt = loadPkt('pkt-002-anthropic.messages.json')
  const { claude } = toClaudeMessages('anthropic.messages', pkt.inbound_body, {})
  const text = JSON.stringify(claude.messages)
  assert.match(text, /CAP_MSG/)
  assert.equal(claude.max_tokens, 32)
})

test('pkt-003 openai.responses → Claude preserves user text', () => {
  const pkt = loadPkt('pkt-003-openai.responses.json')
  const { claude } = toClaudeMessages('openai.responses', pkt.inbound_body, {})
  const text = JSON.stringify(claude.messages)
  assert.match(text, /CAP_RESP/)
})

// ---------- identity replace / body preserve ----------
test('identity replace covers device/account/session/settings', () => {
  assert.deepEqual([...IDENTITY_REPLACE], [
    'device_id',
    'account_uuid',
    'session_id_hash',
    'authorization',
    'fingerprint',
    'settings',
  ])
})

test('identity replace keeps slot device_id; session hashed; tools kept', () => {
  const pkt = loadPkt('synth-tools-metadata.anthropic.json')
  const official = officialMessagesBody(pkt.inbound_body)
  official.metadata = {
    user_id: JSON.stringify({ device_id: 'caller-device', account_uuid: '', session_id: 'caller-sess' }),
  }
  const out = applyCrsIdentityReplace(official, VM_IDENTITY, official)
  assert.equal(out.tools[0].name, 'Read')
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, VM_IDENTITY.deviceId)
  assert.equal(uid.account_uuid, 'vm-account-uuid')
  assert.notEqual(uid.session_id, 'caller-sess')
  assert.notEqual(uid.session_id, 'vm-session-fixed')
})

test('identity replace drops client settings and machine identity', () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    settings: { theme: 'light' },
    metadata: { user_id: 'windows', machine_id: 'pc' },
  }
  const out = applyCrsIdentityReplace(body, VM_IDENTITY)
  assert.equal(out.settings, undefined)
  assert.notEqual(out.metadata.user_id, 'windows')
  assert.equal(out.metadata.machine_id, undefined)
})

test('workspace defaults to client', () => {
  assert.equal(resolveWorkspaceMode({}, {}, ''), 'client')
  assert.equal(resolveWorkspaceMode({ headers: { 'x-kin-workspace': 'vm' } }, {}, ''), 'vm')
})

// ---------- host-process HTTP hop stays disabled; Go worker owns Anthropic I/O ----------
test('callAnthropicMessages host hop is disabled (Go worker owns the hop)', async () => {
  const r = await callAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  assert.equal(r.status, 501)
  assert.equal(r.ok, false)
  assert.match(String(r.body?.error?.message || ''), /disabled|worker/i)
})

test('streamAnthropicMessages host hop is disabled', async () => {
  const r = await streamAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  assert.equal(r.status, 501)
  assert.equal(r.ok, false)
})

// ---------- OAuth single writer (temp vm.json, fake tokens) ----------
test('persistOauthToVm is the writer for fake oauth fields', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-test.json')
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-test', claude: {} }, null, 2))
  persistOauthToVm(vmPath, {
    access_token: 'sk-ant-oat01-TESTONLY',
    refresh_token: 'rt-TESTONLY',
    expires_at: Date.now() + 3600_000,
    email: 'test@example.com',
    account_uuid: 'acc-test',
    source: 'test-fixture',
    mode: 'oauth',
  })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.access_token, 'sk-ant-oat01-TESTONLY')
  assert.equal(vm.claude.email, 'test@example.com')
  assert.equal(vm.claude.source, 'test-fixture')
  assert.ok(vm.claude.refreshed_at)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('normalizeOauth maps alternate field names', () => {
  const n = normalizeOauth({
    accessToken: 'a',
    refreshToken: 'b',
    expiresAt: 123,
    accountUuid: 'acc',
  })
  assert.equal(n.access_token, 'a')
  assert.equal(n.refresh_token, 'b')
  assert.equal(n.expires_at, 123)
  assert.equal(n.account_uuid, 'acc')
})

// ---------- official body allowlist keeps business fields ----------
test('officialMessagesBody keeps tools/system/messages from synth', () => {
  const pkt = loadPkt('synth-tools-metadata.anthropic.json')
  const out = officialMessagesBody(pkt.inbound_body)
  assert.ok(out.messages)
  assert.ok(out.tools)
  assert.equal(out.tools[0].name, 'Read')
  // settings not in Anthropic official allowlist typically
})

test('officialMessagesBody keeps output_config and other official extras', () => {
  const { claude } = toClaudeMessages('anthropic.messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' },
    extra_body: { drop: true },
    messages: [{ role: 'user', content: 'json' }],
  })
  const out = officialMessagesBody(claude)
  assert.equal(out.output_config.effort, 'high')
  assert.equal(out.output_config.format.type, 'json_schema')
  assert.equal(out.extra_body, undefined)
})
