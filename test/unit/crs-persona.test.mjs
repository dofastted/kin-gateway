import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  buildBillingAttributionText,
  computeClaudeCodeFingerprint,
  CRS_OFFICIAL_SYSTEM,
  CRS_SYSTEM_EXPANSION,
  DEFAULT_CLI_VERSION,
  DEFAULT_PERSONA_MODE,
  FINGERPRINT_SALT,
  isOfficialClaudeCodeTraffic,
  normalizePersonaMode,
  personaModeFromRouting,
  personaModeFromRoutingFile,
  SYSTEM_INSTRUCTIONS_ACK,
  SYSTEM_INSTRUCTIONS_PREFIX,
} from '../../src/lib/identity/crs-persona.mjs'

function expectedFp(firstUserText, cliVersion = DEFAULT_CLI_VERSION) {
  const buf = Buffer.from(String(firstUserText), 'utf8')
  let chars = ''
  for (const i of [4, 7, 20]) chars += i < buf.length ? String.fromCharCode(buf[i]) : '0'
  return createHash('sha256').update(FINGERPRINT_SALT + chars + cliVersion, 'utf8').digest('hex').slice(0, 3)
}

test('official Claude Code client leaves system untouched', () => {
  const body = {
    system: [{ type: 'text', text: 'x'.repeat(200) }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = applyCrsUnofficialPersona(body, { officialClient: true })
  assert.equal(out.system[0].text.length, 200)
  assert.equal(out.system.length, 1)
  assert.equal(out.messages.length, 1)
})

test('empty unofficial system becomes exactly 3 blocks and does not insert messages', () => {
  const messages = [{ role: 'user', content: 'ping' }]
  const out = applyCrsUnofficialPersona({ messages }, { officialClient: false })
  assert.equal(out.system.length, 3)
  assert.equal(out.system[0].cache_control, undefined)
  assert.match(out.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.234\.[0-9a-f]{3}; cc_entrypoint=cli;$/)
  assert.ok(!out.system[0].text.includes('cch='))
  assert.equal(out.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.equal(out.system[1].cache_control, undefined)
  assert.equal(out.system[2].text, CRS_SYSTEM_EXPANSION)
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral' })
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].content, 'ping')
})

test('last-night style 3-block inbound becomes 3 outbound blocks and parks the 115KB persona', () => {
  const persona = 'security monitor persona ' + 'P'.repeat(115_000)
  const session = 'Session Context: conv-abc'
  const firstUser = 'heartbeat please reply ok now'
  const body = {
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.238.d8d; cc_entrypoint=cli;' },
      { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: session },
    ],
    messages: [{ role: 'user', content: firstUser }],
  }
  const out = applyCrsUnofficialPersona(body, { officialClient: false })
  assert.equal(out.system.length, 3)
  assert.equal(out.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.notEqual(out.system[0].text, body.system[0].text)
  assert.match(out.system[0].text, new RegExp(`cc_version=${DEFAULT_CLI_VERSION}\\.${expectedFp(firstUser)}`))
  assert.ok(!out.system.some((b) => (b.text || '').includes('security monitor persona')))
  assert.ok(!out.system.some((b) => (b.text || '').includes('Session Context')))

  const parked = out.messages[0]
  assert.equal(parked.role, 'user')
  const parkedText = parked.content[0].text
  assert.ok(parkedText.startsWith(SYSTEM_INSTRUCTIONS_PREFIX))
  assert.ok(parkedText.includes(persona))
  assert.ok(parkedText.includes(session))
  assert.ok(parkedText.length > 115_000)
  assert.equal(out.messages[1].role, 'assistant')
  assert.equal(out.messages[1].content[0].text, SYSTEM_INSTRUCTIONS_ACK)
  assert.equal(out.messages[2].content, firstUser)
})

test('standalone official line does not insert System Instructions', () => {
  const out = applyCrsUnofficialPersona({
    system: [{ type: 'text', text: CRS_OFFICIAL_SYSTEM }],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(out.system.length, 3)
  assert.equal(out.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.equal(out.messages.length, 1)
  assert.ok(!JSON.stringify(out.messages).includes('[System Instructions]'))
})

test('fingerprint is stable for the same first user text and cli version', () => {
  const user = 'abcdefghijklmnopqrstuvwxyz'
  const a = buildBillingAttributionText(user, '2.1.234')
  const b = buildBillingAttributionText(user, '2.1.234')
  const other = buildBillingAttributionText('zzzzzzzzzzzzzzzzzzzzzzzzz', '2.1.234')
  assert.equal(a, b)
  assert.equal(computeClaudeCodeFingerprint(user, '2.1.234'), expectedFp(user))
  assert.notEqual(a, other)
  assert.equal(a, `x-anthropic-billing-header: cc_version=2.1.234.${expectedFp(user)}; cc_entrypoint=cli;`)
})

test('fingerprint uses first user text before parking system instructions', () => {
  const firstUser = 'original first user text xx'
  const out = applyCrsUnofficialPersona({
    system: 'keep this persona',
    messages: [{ role: 'user', content: firstUser }],
  })
  assert.match(out.system[0].text, new RegExp(expectedFp(firstUser)))
  assert.ok(!out.system[0].text.includes(expectedFp('[System Instructions]\nkeep this persona')))
})

test('cliVersion can be parsed from a slot user-agent', () => {
  const out = applyCrsUnofficialPersona({
    messages: [{ role: 'user', content: 'hello' }],
  }, { cliVersion: 'claude-cli/2.1.200 (external, cli)' })
  assert.match(out.system[0].text, /cc_version=2\.1\.200\.[0-9a-f]{3}/)
})

test('persona mode append attaches the official one-liner and keeps caller system', () => {
  const body = {
    system: 'You are currently in Xcode. Help with Swift.',
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = applyCrsUnofficialPersona(body, { mode: 'append' })
  assert.equal(typeof out.system, 'string')
  assert.match(out.system, /Xcode/)
  assert.match(out.system, /Claude Code/)
  assert.equal(out.messages.length, 1)
})

test('persona mode none leaves unofficial system text but strips cache_control', () => {
  const body = {
    system: [{ type: 'text', text: 'keep me', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = applyCrsUnofficialPersona(body, { mode: 'none' })
  assert.equal(out.system.length, 1)
  assert.equal(out.system[0].text, 'keep me')
  assert.equal(out.system[0].cache_control, undefined)
  assert.equal(out.messages.length, 1)
})

test('spoofed claude-cli UA without valid user_id still gets default mimic', () => {
  const body = {
    system: 'you are a linter',
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = applyCrsUnofficialPersona(body, {
    headers: { 'user-agent': 'claude-cli/2.1.234 (external, cli)' },
    mode: 'rewrite',
  })
  assert.equal(out.system.length, 3)
  assert.equal(out.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.match(out.messages[0].content[0].text, /you are a linter/)
})

test('official claude-cli UA plus valid user_id skips mimic', () => {
  const body = {
    system: [{ type: 'text', text: 'x'.repeat(200) }],
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: 'acc-1', session_id: 'sess-1' }) },
  }
  const out = applyCrsUnofficialPersona(body, {
    headers: { 'user-agent': 'claude-cli/2.1.234 (external, cli)' },
    mode: 'rewrite',
  })
  assert.equal(out.system.length, 1)
  assert.equal(out.system[0].text.length, 200)
  assert.equal(isOfficialClaudeCodeTraffic(
    { 'user-agent': 'claude-cli/2.1.234 (external, cli)' },
    body,
  ), true)
})

test('persona_inject aliases normalize from routing', () => {
  assert.equal(DEFAULT_PERSONA_MODE, 'rewrite')
  assert.equal(normalizePersonaMode('append'), 'append')
  assert.equal(normalizePersonaMode('off'), 'none')
  assert.equal(normalizePersonaMode(''), 'rewrite')
  assert.equal(personaModeFromRouting({ compatibility: { persona_inject: 'none' } }), 'none')
  assert.equal(personaModeFromRouting({ compatibility: { persona_inject: 'attach' } }), 'append')
  assert.equal(personaModeFromRouting({ compatibility: { persona_inject: 'rewrite' } }), 'rewrite')
})

test('personaModeFromRoutingFile rereads disk so scp applies without restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-persona-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ compatibility: { persona_inject: 'append' } }))
  assert.equal(personaModeFromRoutingFile(file), 'append')
  fs.writeFileSync(file, JSON.stringify({ compatibility: { persona_inject: 'rewrite' } }))
  assert.equal(personaModeFromRoutingFile(file), 'rewrite')
  fs.rmSync(dir, { recursive: true, force: true })
})
