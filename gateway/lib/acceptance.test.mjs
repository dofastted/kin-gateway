/**
 * Offline acceptance tests — no real OAuth keys, no api.anthropic.com.
 * Fixtures from gateway captures (redacted) + synthetic tools/metadata body.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toClaudeMessages } from './convert.mjs'
import { officialMessagesBody, callAnthropicMessages, streamAnthropicMessages } from './anthropic-messages.mjs'
import {
  applyForwardReplace,
  applyVmStandardReplace,
  resolveForwardMode,
  VM_STANDARD_REPLACE,
  CRS_REPLACE,
  FORWARD_MODES,
} from './forward-mode.mjs'
import { resolveWorkspaceMode } from './workspace-mode.mjs'
import { persistOauthToVm, harvestHomeToVm, normalizeOauth } from './oauth-refresh.mjs'
import { formatMetadataUserId } from './vm-identity.mjs'

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
test('cli uses VM_STANDARD_REPLACE; relay uses CRS_REPLACE', () => {
  assert.deepEqual([...FORWARD_MODES.cli.replace], [...VM_STANDARD_REPLACE])
  assert.deepEqual([...FORWARD_MODES.relay.replace], [...CRS_REPLACE])
})

test('synth: tools and messages preserved after CLI identity replace', () => {
  const pkt = loadPkt('synth-tools-metadata.anthropic.json')
  const official = officialMessagesBody(pkt.inbound_body)
  const out = applyForwardReplace('cli', official, VM_IDENTITY)
  assert.ok(Array.isArray(out.tools) && out.tools.length === 1)
  assert.equal(out.tools[0].name, 'Read')
  assert.equal(out.tool_choice?.type, 'auto')
  const text = JSON.stringify(out.messages)
  assert.match(text, /CAP_MSG/)
  assert.equal(out.settings, undefined)
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.session_id, 'vm-session-fixed')
  assert.equal(uid.account_uuid, 'vm-account-uuid')
  assert.equal(uid.device_id, 'b'.repeat(64))
})

test('relay replaces VM device_id only; session hashed CRS-style; tools kept', () => {
  const pkt = loadPkt('synth-tools-metadata.anthropic.json')
  const official = officialMessagesBody(pkt.inbound_body)
  official.metadata = {
    user_id: JSON.stringify({ device_id: 'caller-device', account_uuid: '', session_id: 'caller-sess' }),
  }
  const out = applyForwardReplace('relay', official, VM_IDENTITY, official)
  assert.equal(out.tools[0].name, 'Read')
  const uid = JSON.parse(out.metadata.user_id)
  assert.equal(uid.device_id, VM_IDENTITY.deviceId)
  assert.equal(uid.account_uuid, 'vm-account-uuid')
  assert.notEqual(uid.session_id, 'caller-sess')
  assert.notEqual(uid.session_id, 'vm-session-fixed')
})

test('applyVmStandardReplace drops client settings and machine identity', () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'hi' }],
    settings: { theme: 'light' },
    metadata: { user_id: 'windows', machine_id: 'pc' },
  }
  const out = applyVmStandardReplace(body, VM_IDENTITY)
  assert.equal(out.settings, undefined)
  assert.notEqual(out.metadata.user_id, 'windows')
  assert.equal(out.metadata.machine_id, undefined)
})

test('resolveForwardMode defaults to relay; cli is explicit fallback', () => {
  assert.equal(resolveForwardMode({}, {}), 'relay')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'sub2api' } }, {}), 'relay')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'crs' } }, {}), 'relay')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'cliproxy' } }, {}), 'cli')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'cli' } }, {}), 'cli')
})

test('workspace defaults to client', () => {
  assert.equal(resolveWorkspaceMode({}, {}, ''), 'client')
  assert.equal(resolveWorkspaceMode({ headers: { 'x-kin-workspace': 'vm' } }, {}, ''), 'vm')
})

// ---------- host-process HTTP hop stays disabled; CRS uses uid worker ----------
test('callAnthropicMessages host hop is disabled (CRS is uid worker)', async () => {
  const r = await callAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  assert.equal(r.status, 501)
  assert.equal(r.ok, false)
  assert.match(String(r.body?.error?.message || ''), /disabled|crs-relay|VM UID/i)
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

test('harvestHomeToVm writes CLI credentials to the given VM path only', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  const home = path.join(dir, 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-x',
    claude: { access_token: 'old', refresh_token: 'oldrt', expires_at: 10 },
  }))
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'home-at',
      refreshToken: 'home-rt',
      expiresAt: 2000000000000,
    },
  }))
  const r = harvestHomeToVm(path.join(dir, 'cli-home'), vmPath)
  assert.equal(r.harvested, true)
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.access_token, 'home-at')
  assert.equal(vm.claude.refresh_token, 'home-rt')
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
