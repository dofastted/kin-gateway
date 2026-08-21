import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  needsRefresh,
  expiresAtToMs,
  normalizeOauth,
  applyOauthToCfg,
  persistOauthToVm,
  redactOauthToken,
  REFRESH_SKEW_MS,
} from '../../src/lib/oauth/oauth-credentials.mjs'

test('needsRefresh: missing/expired/skew', () => {
  const now = 1_000_000_000_000
  assert.equal(needsRefresh(null, now), true)
  assert.equal(needsRefresh(now / 1000 - 10, now), true)
  assert.equal(needsRefresh(now / 1000 + 60, now), true)
  assert.equal(needsRefresh(now / 1000 + REFRESH_SKEW_MS / 1000 + 120, now), false)
})

test('expiresAtToMs accepts seconds and ms', () => {
  assert.equal(expiresAtToMs(1786951995), 1786951995000)
  assert.equal(expiresAtToMs(1786951995000), 1786951995000)
})

test('normalizeOauth maps both casings and computes expires_at', () => {
  const n = normalizeOauth({
    accessToken: 'at',
    refreshToken: 'rt',
    expires_in: 100,
  })
  assert.equal(n.access_token, 'at')
  assert.equal(n.refresh_token, 'rt')
  assert.ok(n.expires_at > Math.floor(Date.now() / 1000) + 50)
})

test('persist + apply keep other vm fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-x',
    policy: { maxConcurrency: 2 },
    claude: { email: 'a@b.c', access_token: 'old', refresh_token: 'oldrt', extra: 1, session_key: 'sk-keep' },
  }))
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.policy.maxConcurrency, 2)
  assert.equal(vm.claude.email, 'a@b.c')
  assert.equal(vm.claude.extra, 1)
  assert.equal(vm.claude.access_token, 'new')
  assert.equal(vm.claude.refresh_token, 'newrt')
  assert.equal(vm.claude.expires_at, 99)
  assert.equal(vm.claude.session_key, 'sk-keep')
  assert.ok(vm.claude._token_version > 0)

  const cfg = { vm: { access_token: 'old', refresh_token: 'oldrt', expires_at: 1 } }
  applyOauthToCfg(cfg, vm.claude)
  assert.equal(cfg.vm.access_token, 'new')
  assert.equal(cfg.vm.expires_at, 99)
})

test('persistOauthToVm returns null for a missing vm file', () => {
  assert.equal(persistOauthToVm('/nonexistent/vm.json', { access_token: 'x' }), null)
})

test('redactOauthToken keeps prefix and tail only', () => {
  assert.equal(redactOauthToken(''), null)
  assert.equal(redactOauthToken('sk-ant-oat01-ABCDEFGH12345678TAILXXXX'), 'sk-ant-oat01…TAILXXXX')
  assert.equal(redactOauthToken('short'), 'shor…')
})
