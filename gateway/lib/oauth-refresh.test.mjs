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
  shouldKeepCliOauth,
  rereadVmOauth,
  harvestHomeToVm,
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

test('ensureFresh never calls refreshFn — harvest only', async () => {
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
      return { access_token: 'new', refresh_token: 'rt2', expires_in: 28800 }
    },
  })
  const [a, b] = await Promise.all([guard.ensureFresh(), guard.ensureFresh()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(calls, 0, 'must never call grant_type=refresh_token')
  assert.equal(cfg.vm.access_token, 'old')
  assert.equal(a.refreshed, false)

  const forced = await guard.ensureFresh({ force: true })
  assert.equal(forced.ok, true)
  assert.equal(calls, 0, 'force still must not call Anthropic refresh')
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
  const guard = createOauthGuard(cfg)
  const h = guard.harvestFromHome(home)
  assert.equal(h.harvested, true)
  assert.equal(cfg.vm.access_token, 'cli')
})

test('shouldKeepCliOauth keeps same-window rotation', () => {
  const now = Date.now()
  assert.equal(shouldKeepCliOauth(
    { access_token: 'a2', refresh_token: 'r2', expires_at: now + 8 * 3600 * 1000 },
    { access_token: 'a1', refresh_token: 'r1', expires_at: now + 8 * 3600 * 1000 },
  ), true)
  assert.equal(shouldKeepCliOauth(
    { access_token: 'old', refresh_token: 'oldrt', expires_at: now + 1000 },
    { access_token: 'new', refresh_token: 'newrt', expires_at: now + 8 * 3600 * 1000 },
  ), false)
})

test('ensureFresh harvests CLI and does not refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const home = path.join(dir, 'cli-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const nowSec = Math.floor(Date.now() / 1000)
  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-x',
    claude: { access_token: 'old', refresh_token: 'rt1', expires_at: nowSec + 30 },
  }))
  fs.writeFileSync(path.join(home, '.claude', 'credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'cli-new',
      refreshToken: 'rt-cli',
      expiresAt: (nowSec + 8000) * 1000,
    },
  }))
  const cfg = {
    vm: { id: 'vm-x', path: vmPath, access_token: 'old', refresh_token: 'rt1', expires_at: nowSec + 30 },
  }
  let calls = 0
  const guard = createOauthGuard(cfg, {
    refreshFn: async () => { calls += 1; return { access_token: 'nope' } },
  })
  const r = await guard.ensureFresh({ homeDir: home })
  assert.equal(r.ok, true)
  assert.equal(r.harvested, true)
  assert.equal(cfg.vm.access_token, 'cli-new')
  assert.equal(calls, 0)
})

test('recoverFromSessionKey uses CookieAuth not refresh_token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-x',
    claude: { session_key: 'sk-ant-sid-test', access_token: 'dead' },
  }))
  const cfg = {
    vm: { id: 'vm-x', path: vmPath, session_key: 'sk-ant-sid-test', access_token: 'dead' },
  }
  let refreshCalls = 0
  let importCalls = 0
  const guard = createOauthGuard(cfg, {
    refreshFn: async () => { refreshCalls += 1; throw new Error('should not refresh') },
  })
  const r = await guard.recoverFromSessionKey({
    importFn: async (sk) => {
      importCalls += 1
      assert.equal(sk, 'sk-ant-sid-test')
      return { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 28800 }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.reimported, true)
  assert.equal(importCalls, 1)
  assert.equal(refreshCalls, 0)
  assert.equal(cfg.vm.access_token, 'new-at')
  assert.equal(cfg.vm.refresh_token, 'new-rt')
})

test('no credentials → need_reimport', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-x', claude: {} }))
  const cfg = { vm: { id: 'vm-x', path: vmPath } }
  const guard = createOauthGuard(cfg)
  const r = await guard.ensureFresh()
  assert.equal(r.ok, false)
  assert.equal(r.need_reimport, true)
})

test('reread disk tokens into memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  const nowSec = Math.floor(Date.now() / 1000)
  fs.writeFileSync(vmPath, JSON.stringify({
    id: 'vm-x',
    claude: { access_token: 'disk', refresh_token: 'rt-disk', expires_at: nowSec - 10, session_key: 'sk-disk' },
  }))
  const cfg = {
    vm: { id: 'vm-x', path: vmPath, access_token: 'mem', refresh_token: 'rt-mem', expires_at: nowSec - 10 },
  }
  assert.equal(rereadVmOauth(cfg), true)
  assert.equal(cfg.vm.refresh_token, 'rt-disk')
  assert.equal(cfg.vm.session_key, 'sk-disk')
})

test('harvestHomeToVm writes CLI credentials to the given VM path only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
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
})

