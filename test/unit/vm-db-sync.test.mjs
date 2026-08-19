import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { encryptString, decryptString, isEncrypted } from '../../src/lib/db/secure.mjs'
import { initVmDbSync, stopVmWatch, syncVmFile, removeVmFromDb, reconcileVms } from '../../src/lib/vm-db-sync.mjs'
import { setVmWriteHook, atomicWriteJson } from '../../src/lib/vm-file.mjs'
import { persistOauthToVm } from '../../src/lib/oauth-refresh.mjs'
import { setVmSchedulable, setActiveVm } from '../../src/lib/vm-registry.mjs'

let project

function seedVmFile(id = 'vm-t1', extra = {}) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    name: 'test',
    status: 'running',
    timezone: 'UTC',
    claude: {
      access_token: 'sk-ant-oat01-AAA',
      refresh_token: 'sk-ant-ort01-BBB',
      session_key: 'sk-ant-sid01-CCC',
      email: 't@x.io',
      account_uuid: 'acct-1',
      expires_at: 1893456000,
      source: 'test',
    },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm, null, 2))
  return vm
}

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmsync-'))
  openDatabase({ dataDir: path.join(project, 'data') })
})

afterEach(() => {
  stopVmWatch()
  setVmWriteHook(null)
  closeDatabase()
  fs.rmSync(project, { recursive: true, force: true })
  delete process.env.KIN_DB_SECRET
})

test('initVmDbSync reconciles existing vm files into DB (credentials included)', () => {
  seedVmFile('vm-t1')
  setActiveVm(project, 'vm-t1')
  const res = initVmDbSync(project, { watch: false })
  assert.equal(res.upserted, 1)
  const repo = new VmsRepo(getDb())
  const row = repo.get('vm-t1')
  assert.equal(row.access_token, 'sk-ant-oat01-AAA')
  assert.equal(row.refresh_token, 'sk-ant-ort01-BBB')
  assert.equal(row.session_key, 'sk-ant-sid01-CCC')
  assert.equal(row.email, 't@x.io')
  assert.equal(row.vm.claude.access_token, 'sk-ant-oat01-AAA')
  assert.equal(repo.getActiveVmId(), 'vm-t1')
})

test('write-through hook mirrors persistOauthToVm into DB', () => {
  seedVmFile('vm-t2')
  initVmDbSync(project, { watch: false })
  const vmPath = path.join(project, 'vms', 'vm-t2.json')
  persistOauthToVm(vmPath, {
    access_token: 'sk-ant-oat01-NEW',
    refresh_token: 'sk-ant-ort01-NEW',
    expires_at: 1893460000,
  })
  const repo = new VmsRepo(getDb())
  const row = repo.get('vm-t2')
  assert.equal(row.access_token, 'sk-ant-oat01-NEW')
  assert.equal(row.refresh_token, 'sk-ant-ort01-NEW')
})

test('vm-registry writes are mirrored (setVmSchedulable)', () => {
  seedVmFile('vm-t3')
  initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3', false, 'test-reason')
  const row = new VmsRepo(getDb()).get('vm-t3')
  assert.equal(row.schedulable, false)
  assert.equal(row.vm.schedule_disabled_reason, 'test-reason')
})

test('reconcile rebuilds missing vm file from DB (restore pull-up)', () => {
  const vm = seedVmFile('vm-t4')
  initVmDbSync(project, { watch: false })
  const vmPath = path.join(project, 'vms', 'vm-t4.json')
  fs.rmSync(vmPath)
  const res = reconcileVms(project)
  assert.equal(res.rebuilt, 1)
  assert.ok(fs.existsSync(vmPath))
  const back = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(back.claude.access_token, vm.claude.access_token)
})

test('removeVmFromDb drops the row', () => {
  seedVmFile('vm-t5')
  initVmDbSync(project, { watch: false })
  assert.equal(removeVmFromDb('vm-t5'), true)
  assert.equal(new VmsRepo(getDb()).get('vm-t5'), null)
})

test('KIN_DB_SECRET encrypts credentials at rest, decrypts on read', () => {
  process.env.KIN_DB_SECRET = 'test-secret-123'
  seedVmFile('vm-t6')
  initVmDbSync(project, { watch: false })
  // raw row must be ciphertext
  const raw = getDb().prepare('SELECT access_token, vm_json, encrypted FROM vms WHERE id = ?').get('vm-t6')
  assert.equal(raw.encrypted, 1)
  assert.ok(isEncrypted(raw.access_token), 'access_token column should be encrypted')
  assert.ok(isEncrypted(raw.vm_json), 'vm_json should be encrypted')
  assert.doesNotMatch(String(raw.access_token), /sk-ant-oat01/)
  // repo read decrypts
  const row = new VmsRepo(getDb()).get('vm-t6')
  assert.equal(row.access_token, 'sk-ant-oat01-AAA')
  assert.equal(row.vm.claude.refresh_token, 'sk-ant-ort01-BBB')
})

test('secure round-trip + tamper detection', () => {
  const ct = encryptString('hello', 's3cret')
  assert.ok(isEncrypted(ct))
  assert.equal(decryptString(ct, 's3cret'), 'hello')
  assert.throws(() => decryptString(ct, 'wrong-secret'))
  assert.equal(decryptString('plain-value', 's3cret'), 'plain-value')
})

test('syncVmFile no-ops safely when DB is closed', () => {
  seedVmFile('vm-t7')
  closeDatabase()
  assert.equal(syncVmFile(path.join(project, 'vms', 'vm-t7.json')), false)
  assert.equal(removeVmFromDb('vm-t7'), false)
  // atomicWriteJson still works without a hook/DB
  atomicWriteJson(path.join(project, 'vms', 'vm-t7.json'), { id: 'vm-t7' })
})

test('file newer than DB wins on reconcile (mtime compare)', async () => {
  seedVmFile('vm-t8')
  initVmDbSync(project, { watch: false })
  // simulate external edit with a newer mtime
  await new Promise((r) => setTimeout(r, 20))
  const vmPath = path.join(project, 'vms', 'vm-t8.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude.access_token = 'sk-ant-oat01-EXTERNAL'
  fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2))
  const res = reconcileVms(project)
  assert.equal(res.upserted, 1)
  assert.equal(new VmsRepo(getDb()).get('vm-t8').access_token, 'sk-ant-oat01-EXTERNAL')
})
