import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  shanghaiDay,
  turnFileName,
  promptWritePath,
  buildReportPrompt,
  buildFollowupPrompt,
  ensureReportsDir,
  listSavedReports,
  readSavedReport,
  REPORTS_PUBLIC_ROOT,
} from '../../src/lib/admin/concurrent-test.mjs'

test('shanghaiDay is YYYY-MM-DD', () => {
  assert.match(shanghaiDay(new Date('2026-08-20T16:00:00Z')), /^\d{4}-\d{2}-\d{2}$/)
})

test('prompt tells Claude the dated write path', () => {
  const session = { index: 0, stock: { ticker: 'TSLA', name: 'Tesla' }, model: 'claude-opus-5' }
  const dest = promptWritePath('2026-08-20', session, 1)
  assert.equal(dest, `${REPORTS_PUBLIC_ROOT}/2026-08-20/01-TSLA-claude-opus-5-t1.md`)
  const prompt = buildReportPrompt(session.stock, dest)
  assert.match(prompt, /写入文件：\/opt\/kin-gateway\/data\/loadtests\/reports\/2026-08-20\/01-TSLA-claude-opus-5-t1\.md/)
  assert.match(buildFollowupPrompt(session.stock, 2, dest), /写入文件：/)
})

test('list/read saved reports stays inside the day directory', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-lt-'))
  const day = '2026-08-20'
  const dir = ensureReportsDir(dataDir, day)
  const name = turnFileName({ index: 2, stock: { ticker: 'AAPL' }, model: 'claude-haiku-4-5' }, 1)
  fs.writeFileSync(path.join(dir, name), '# AAPL 研报\n正文')
  const listed = listSavedReports(dataDir, day)
  assert.equal(listed.day, day)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].name, name)
  const rec = readSavedReport(dataDir, day, name)
  assert.match(rec.text, /AAPL 研报/)
  assert.equal(readSavedReport(dataDir, day, '../secret.md'), null)
  assert.equal(readSavedReport(dataDir, 'nope', name), null)
})
