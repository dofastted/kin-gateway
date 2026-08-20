import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { runVmTestChat } from '../../src/lib/admin/vm-test-chat.mjs'

test('runVmTestChat writes a request_logs row so test usage is billed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-'))
  const store = new RequestLogStore({ dataDir: dir, mode: 'normal' })
  const result = await runVmTestChat({ vmId: 'vm-01', requestLog: store })
  assert.equal(result.ok, false)
  const rows = store.listNormal({ limit: 5 })
  assert.equal(rows.length, 1)
  assert.match(rows[0].path, /\/api\/panel\/vms\/vm-01\/test-chat/)
  assert.equal(rows[0].user_agent, 'kin-console-test/1.0')
  assert.equal(rows[0].error_code, 'invalid_request')
})
