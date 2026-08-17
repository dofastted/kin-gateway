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
  readCliOauth,
  createOauthGuard,
  REFRESH_SKEW_MS,
} from './oauth-refresh.mjs'

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
    claude: { email: 'a@b.c', access_token: 'old', refresh_token: 'oldrt', extra: 1 },
  }))
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.policy.maxConcurrency, 2)
  assert.equal(vm.claude.email, 'a@b.c')
  assert.equal(vm.claude.extra, 1)
  assert.equal(vm.claude.access_token, 'new')
  assert.equal(vm.claude.refresh_token, 'newrt')
  assert.equal(vm.claude.expires_at, 99)

  const cfg = { vm: { access_token: 'old', refresh_token: 'oldrt', expires_at: 1 } }
  applyOauthToCfg(cfg, vm.claude)
  assert.equal(cfg.vm.access_token, 'new')
  assert.equal(cfg.vm.expires_at, 99)
})

test('guard refreshes only when needed and single-flights', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  const nowSec = Math.floor(Date.now() / 1000)
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-x',
    claude: { access_token: 'old', refresh_token: 'rt1', expires_at: nowSec + 30 },
  }))
  const cfg = {
    vm: {
      id: 'vm-x',
      path: vmPath,
      access_token: 'old',
      refresh_token: 'rt1',
      expires_at: nowSec + 30,
    },
  }
  let calls = 0
  const guard = createOauthGuard(cfg, {
    refreshFn: async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 20))
      return { access_token: 'new', refresh_token: 'rt2', expires_in: 28800 }
    },
  })
  const [a, b] = await Promise.all([guard.ensureFresh(), guard.ensureFresh()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(calls, 1)
  assert.equal(cfg.vm.access_token, 'new')
  assert.equal(cfg.vm.refresh_token, 'rt2')
  assert.ok(cfg.vm.expires_at > nowSec + 1000)

  const again = await guard.ensureFresh()
  assert.equal(again.refreshed, false)
  assert.equal(calls, 1)
})

test('invalid_grant asks for sessionKey reimport', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-x', claude: {} }))
  const cfg = {
    vm: { id: 'vm-x', path: vmPath, access_token: 'x', refresh_token: 'dead', expires_at: 1 },
  }
  const guard = createOauthGuard(cfg, {
    refreshFn: async () => {
      const e = new Error('token refresh failed: 400 invalid_grant')
      e.code = 'invalid_grant'
      throw e
    },
  })
  const r = await guard.ensureFresh({ force: true })
  assert.equal(r.ok, false)
  assert.equal(r.need_reimport, true)
})

test('harvest picks up newer CLI credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const home = path.join(dir, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const later = Date.now() + 8 * 3600 * 1000
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'cli', refreshToken: 'clirt', expiresAt: later },
  }))
  const got = readCliOauth(home)
  assert.equal(got.access_token, 'cli')
  assert.equal(got.refresh_token, 'clirt')
  assert.ok(Math.abs(expiresAtToMs(got.expires_at) - later) < 1000)

  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-x', claude: { access_token: 'old' } }))
  const cfg = { vm: { id: 'vm-x', path: vmPath, access_token: 'old', expires_at: 10 } }
  const guard = createOauthGuard(cfg, { refreshFn: async () => { throw new Error('no') } })
  const h = guard.harvestFromHome(home)
  assert.equal(h.harvested, true)
  assert.equal(cfg.vm.access_token, 'cli')
})
