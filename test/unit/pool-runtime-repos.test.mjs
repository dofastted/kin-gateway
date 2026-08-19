import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountRuntimeRepo } from '../../src/lib/db/repos/account-runtime-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'

test('account runtime state persists account and model cooldowns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-runtime-repo-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new AccountRuntimeRepo(db)
    repo.upsert({
      account_id: 'account-1',
      vm_id: 'vm-01',
      status: 'ready',
      priority: 3,
      weight: 5,
      worker_heartbeat_at: Date.now(),
      worker_status: { ok: true },
    })
    const until = Date.now() + 60_000
    repo.markCooldown('account-1', {
      vmId: 'vm-01',
      model: 'claude-test',
      until,
      reason: 'model_rate_limit',
    })
    const state = repo.get('account-1')
    assert.equal(state.priority, 3)
    assert.equal(state.weight, 5)
    assert.equal(state.model_states['claude-test'].reason, 'model_rate_limit')
    assert.equal(state.model_states['claude-test'].cooldown_until, until)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('request attempt ledger records final state and commit boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-attempt-repo-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RequestAttemptsRepo(db)
    repo.begin({
      requestId: 'req-1',
      attemptNo: 1,
      vmId: 'vm-01',
      accountId: 'account-1',
      model: 'claude-test',
      selectionReason: 'weighted-round-robin',
      waitMs: 4,
    })
    repo.complete('req-1', 1, {
      upstreamStatus: 429,
      errorScope: 'account',
      action: 'continue-and-cooldown',
      cooldownUntil: Date.now() + 60_000,
      terminalState: 'rejected',
      latencyMs: 12,
    })
    repo.begin({
      requestId: 'req-1',
      attemptNo: 2,
      vmId: 'vm-02',
      accountId: 'account-2',
      model: 'claude-test',
      selectionReason: 'failover',
    })
    repo.complete('req-1', 2, {
      upstreamStatus: 200,
      downstreamCommitted: true,
      terminalState: 'verified',
      usage: { input_tokens: 2, output_tokens: 3 },
      ttftMs: 20,
      latencyMs: 40,
    })
    const attempts = repo.list('req-1')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].action, 'continue-and-cooldown')
    assert.equal(attempts[1].terminal_state, 'verified')
    assert.equal(attempts[1].downstream_committed, true)
    assert.deepEqual(attempts[1].usage, { input_tokens: 2, output_tokens: 3 })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
