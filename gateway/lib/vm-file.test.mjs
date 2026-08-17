import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson, writeJsonIfChanged, withVmLock } from './vm-file.mjs'

test('atomicWriteJson writes valid JSON and leaves no temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-'))
  const p = path.join(dir, 'vm.json')
  atomicWriteJson(p, { a: 1 }, { mode: 0o600 })
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 })
  const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.equal(leftover.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeJsonIfChanged skips identical content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-'))
  const p = path.join(dir, 'vm.json')
  assert.equal(writeJsonIfChanged(p, { a: 1 }), true)
  const m1 = fs.statSync(p).mtimeMs
  assert.equal(writeJsonIfChanged(p, { a: 1 }), false)
  const m2 = fs.statSync(p).mtimeMs
  assert.equal(m1, m2)
  assert.equal(writeJsonIfChanged(p, { a: 2 }), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('withVmLock serializes writers on the same key (no lost update)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-'))
  const p = path.join(dir, 'counter.json')
  fs.writeFileSync(p, JSON.stringify({ n: 0 }))
  const bump = () => withVmLock(p, async () => {
    const cur = JSON.parse(fs.readFileSync(p, 'utf8')).n
    await new Promise((r) => setTimeout(r, 5)) // force interleave window
    atomicWriteJson(p, { n: cur + 1 })
  })
  await Promise.all([bump(), bump(), bump(), bump(), bump()])
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).n, 5)
  fs.rmSync(dir, { recursive: true, force: true })
})
