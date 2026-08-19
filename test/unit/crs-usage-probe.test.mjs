import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseOAuthUsage,
  parseFableProbe,
  normUtilization,
  FABLE_PROBE_MODEL,
  probeVmUsage,
} from '../../src/lib/oauth/crs-usage-probe.mjs'

test('oauth usage parse: 5h / 7d / sonnet / extra', () => {
  const p = parseOAuthUsage({
    five_hour: { utilization: 0.12, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 34, resets_at: '2026-08-24T00:00:00Z' },
    seven_day_sonnet: { utilization: 0.08, resets_at: '2026-08-24T00:00:00Z' },
    extra_usage: { is_enabled: true, utilization: 0.01, status: 'allowed' },
  })
  assert.equal(p.five_hour.utilization, 0.12)
  assert.equal(p.five_hour.status, 'allowed')
  assert.equal(p.seven_day.utilization, 0.34)
  assert.equal(p.seven_day_sonnet.utilization, 0.08)
  assert.equal(p.seven_day_opus.utilization, 0.08)
  assert.equal(p.extra_usage.is_enabled, true)
})

test('normUtilization treats 85 as 0.85', () => {
  assert.equal(normUtilization(85), 0.85)
  assert.equal(normUtilization(0.85), 0.85)
})

test('fable 429 is isolated weekly limit, not account ban', () => {
  const r = parseFableProbe({
    status: 429,
    body: { error: { type: 'rate_limit_error', message: 'fable weekly limit' } },
  })
  assert.equal(r.model, FABLE_PROBE_MODEL)
  assert.equal(r.limited, true)
  assert.equal(r.banned, false)
  assert.equal(r.ok, false)
})

test('fable 401 is banned / rejected, not weekly limit', () => {
  const r = parseFableProbe({
    status: 401,
    body: { error: { type: 'authentication_error', message: 'OAuth token revoked' } },
  })
  assert.equal(r.banned, true)
  assert.equal(r.limited, false)
})

test('KIN_CRS_MOCK probe returns 5h/7d/fable without network', async () => {
  process.env.KIN_CRS_MOCK = '1'
  const r = await probeVmUsage({ exec: { homeDir: '/tmp', vmId: 'vm-01' } })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'vm-oauth-usage')
  assert.ok(r.five_hour.utilization > 0)
  assert.ok(r.seven_day.utilization > 0)
  assert.equal(r.fable.ok, true)
  assert.equal(r.fable.limited, false)
})
