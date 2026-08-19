import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSlotAccessToken, buildCrsRequestHeaders } from '../../src/lib/crs-relay.mjs'
import { shouldFallbackToCli, resolveForwardMode } from '../../src/lib/forward-mode.mjs'

test('all VMs default to CRS relay unless x-kin-forward=cli', () => {
  assert.equal(resolveForwardMode({}, {}), 'relay')
  assert.equal(resolveForwardMode({ headers: {} }, { model: 'x' }), 'relay')
})

test('readSlotAccessToken prefers credentials.json and never requires write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-crs-tok-'))
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude', 'credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-FILE', refreshToken: 'rt', expiresAt: 9e12 },
  }))
  fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
  }))
  const tok = readSlotAccessToken({ homeDir: dir, oauth: { access_token: 'sk-ant-oat01-EXEC' } })
  assert.equal(tok, 'sk-ant-oat01-FILE')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buildCrsRequestHeaders strips caller key and accept-encoding', () => {
  const h = buildCrsRequestHeaders({
    reqHeaders: {
      'user-agent': 'claude-cli/2.1.234 (external, sdk-cli)',
      authorization: 'Bearer gateway-key',
      'x-api-key': 'gateway-key',
      'accept-encoding': 'gzip, zstd',
      'anthropic-version': '2023-06-01',
    },
    homeDir: '',
    accessToken: 'sk-ant-oat01-VM',
    stream: false,
  })
  assert.equal(h.authorization, 'Bearer sk-ant-oat01-VM')
  assert.equal(h['x-api-key'], undefined)
  assert.equal(h['accept-encoding'], undefined)
  assert.equal(h['anthropic-version'], '2023-06-01')
  assert.match(h['user-agent'], /^claude-cli\//)
})

test('CLI fallback is only for transport / 529, never 401/403', () => {
  assert.equal(shouldFallbackToCli({ ok: false, status: 401 }), false)
  assert.equal(shouldFallbackToCli({ ok: false, status: 403 }), false)
  assert.equal(shouldFallbackToCli({ ok: false, status: 429 }), false)
  assert.equal(shouldFallbackToCli({ ok: false, status: 529 }), true)
  assert.equal(shouldFallbackToCli({ ok: false, transportError: true }), true)
})
