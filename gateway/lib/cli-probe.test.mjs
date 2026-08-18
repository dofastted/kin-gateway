import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseJsonFromCli,
  normalizeCliAuthStatus,
  consumeCliNdjson,
  quotaWindowsFromRateLimits,
  epochToIso,
} from './cli-probe.mjs'

test('parseJsonFromCli tolerates wrapper text', () => {
  const raw = normalizeCliAuthStatus(parseJsonFromCli('noise\n{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgId":"o1"}\n'))
  assert.equal(raw.loggedIn, true)
  assert.equal(raw.authMethod, 'claude.ai')
  assert.equal(raw.email, 'a@b.c')
  assert.equal(raw.orgId, 'o1')
})

test('consumeCliNdjson harvests rate_limit_event + result usage', () => {
  const acc = {}
  consumeCliNdjson(JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1786950600,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
    },
  }), acc)
  consumeCliNdjson(JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1787500000,
      rateLimitType: 'seven_day',
    },
  }), acc)
  consumeCliNdjson(JSON.stringify({
    type: 'result',
    result: 'pong',
    usage: { input_tokens: 10, output_tokens: 1 },
  }), acc)
  assert.equal(acc.rate_limits.length, 2)
  assert.equal(acc.text, 'pong')
  assert.equal(acc.usage.output_tokens, 1)
  const win = quotaWindowsFromRateLimits(acc.rate_limits)
  assert.equal(win.five_hour.status, 'allowed')
  assert.equal(win.five_hour.resets_at, epochToIso(1786950600))
  assert.equal(win.five_hour.utilization, null)
  assert.equal(win.seven_day.rate_limit_type, 'seven_day')
})

test('usage-probe delegates to VM UID; host module has no Anthropic URL', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./usage-probe.mjs', import.meta.url), 'utf8'))
  assert.equal(src.includes('api.anthropic.com'), false)
  assert.equal(src.includes('claude-cli/'), false)
  assert.match(src, /probeVmUsage/)
})
