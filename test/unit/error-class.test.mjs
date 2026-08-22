import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRequestError, collectErrors, enrichLogRow } from '../../src/lib/admin/error-class.mjs'

test('classifyRequestError maps known codes and statuses', () => {
  assert.equal(classifyRequestError({ status: 200 }), null)
  assert.equal(classifyRequestError({ status: 503, error_code: 'server_overloaded' }).error_class, 'overloaded')
  assert.equal(classifyRequestError({ status: 429, error_code: 'upstream_rate_limit' }).error_class, 'rate_limit')
  assert.equal(classifyRequestError({ status: 400, error_code: 'invalid_json' }).error_class, 'request')
  assert.equal(classifyRequestError({ status: 400, error_message: 'thinking signature invalid' }).error_class, 'signature')
  assert.equal(classifyRequestError({ status: 401, error_code: 'invalid_api_key' }).error_class, 'auth')
  assert.equal(classifyRequestError({ status: 401, error_code: 'upstream_auth_error' }).error_class, 'credential')
  assert.equal(classifyRequestError({ status: 504, error_code: 'upstream_timeout' }).error_class, 'timeout')
  assert.equal(classifyRequestError({ status: 403, error_message: 'Just a moment Cloudflare' }).error_class, 'proxy')
  assert.equal(classifyRequestError({
    status: 400,
    error_code: 'upstream_invalid_request',
    error_message: 'Invalid `signature` in thinking block',
  }).error_class, 'signature')
  assert.equal(classifyRequestError({
    status: 503,
    error_code: 'upstream_error',
    error_message: '服务器负载过高稍后重试',
  }).error_class, 'overloaded')
  assert.equal(classifyRequestError({ status: 200, error_code: 'ECONNRESET' }), null)
  assert.equal(classifyRequestError({ status: 200, error_code: 'client_cancelled' }), null)
})

test('collectErrors groups by class and code', () => {
  const bag = collectErrors([
    { ts: '2026-08-20T01:00:00Z', request_id: 'a', status: 503, error_code: 'server_overloaded', error_message: '负载过高' },
    { ts: '2026-08-20T01:01:00Z', request_id: 'b', status: 503, error_code: 'server_overloaded', error_message: '负载过高' },
    { ts: '2026-08-20T01:02:00Z', request_id: 'c', status: 429, error_code: 'upstream_rate_limit' },
    { ts: '2026-08-20T01:03:00Z', request_id: 'd', status: 200 },
  ])
  assert.equal(bag.total, 3)
  assert.equal(bag.by_class[0].id, 'overloaded')
  assert.equal(bag.by_class[0].count, 2)
  assert.equal(bag.by_code[0].error_code, 'server_overloaded')
  assert.equal(bag.recent.length, 3)
  assert.equal(enrichLogRow({ status: 503, error_code: 'server_overloaded' }).error_label, '过载排队')
})
