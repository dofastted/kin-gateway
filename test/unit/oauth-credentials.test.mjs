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
  restoreScheduleAfterLiveCredential,
  readWorkerCredentialFile,
  readSlotCredentialIdentity,
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
  assert.equal(vm.claude.has_access, true)
  assert.equal(vm.claude.has_refresh, true)
  assert.equal(vm.claude.access_token, undefined)
  assert.equal(vm.claude.refresh_token, undefined)
  assert.equal(vm.claude.session_key, undefined)
  assert.equal(vm.claude.expires_at, 99)
  assert.ok(vm.claude._token_version > 0)

  const cfg = { vm: { expires_at: 1 } }
  applyOauthToCfg(cfg, vm.claude)
  assert.equal(cfg.vm.access_token, undefined)
  assert.equal(cfg.vm.has_access, true)
  assert.equal(cfg.vm.expires_at, 99)
})

test('persistOauthToVm returns null for a missing vm file', () => {
  assert.equal(persistOauthToVm('/nonexistent/vm.json', { access_token: 'x' }), null)
})

test('persistOauthToVm clears leftover oauth_cleared after a live credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-02.json')
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-02',
    status: 'stopped',
    schedulable: false,
    schedule_disabled_reason: 'oauth_cleared',
    claude: {},
  }))
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.status, 'running')
  assert.equal(vm.schedulable, true)
  assert.equal(vm.schedule_disabled_reason, null)
  assert.equal(vm.claude.has_access, true)
  assert.equal(vm.claude.has_refresh, true)
})

test('persistOauthToVm does not reopen an operator-disabled slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-02.json')
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-02',
    status: 'paused',
    schedulable: false,
    schedule_disabled_reason: 'disabled',
    claude: {},
  }))
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'disabled')
  assert.equal(vm.status, 'paused')
})

test('restoreScheduleAfterLiveCredential ignores operator stopped', () => {
  const vm = {
    status: 'stopped',
    schedulable: false,
    schedule_disabled_reason: 'stopped',
    claude: { has_access: true, has_refresh: true },
  }
  restoreScheduleAfterLiveCredential(vm)
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'stopped')
})

test('slot identity only reads worker credentials.json, never leftover dotfile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-cred-'))
  const claude = path.join(home, '.claude')
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(path.join(claude, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accountUuid: 'wrong-leftover', accessToken: 'old', refreshToken: 'oldrt' },
  }))
  assert.equal(readWorkerCredentialFile(home), null)
  assert.equal(readSlotCredentialIdentity(home), null)
  fs.writeFileSync(path.join(claude, 'credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accountUuid: 'slot-account',
      orgUuid: 'slot-org',
      email: 'slot@example.com',
      accessToken: 'live',
      refreshToken: 'livert',
    },
  }))
  const id = readSlotCredentialIdentity(home)
  assert.equal(id.account_uuid, 'slot-account')
  assert.equal(id.org_uuid, 'slot-org')
  assert.equal(id.email, 'slot@example.com')
  assert.equal(id.source, 'slot-credentials.json')
  assert.equal(id.has_access, true)
  assert.ok(!Object.prototype.hasOwnProperty.call(id, 'access_token'))
})
