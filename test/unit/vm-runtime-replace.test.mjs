import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldReplaceSlotContainer } from '../../src/lib/vm/vm-runtime.mjs'

const running = { running: true, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }
const stopped = { running: false, networkMode: 'host', image: 'kin-os/ubuntu:24.04' }

test('running slot is never replaced unless recreate is explicit', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: running, recreate: false, network: 'bridge', image: 'other' }), false)
  assert.equal(shouldReplaceSlotContainer({ existing: running, recreate: true, network: 'host', image: running.image }), true)
})

test('stopped slot is replaced only when net or image is wrong', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: stopped.image }), false)
  assert.equal(shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'bridge', image: stopped.image }), true)
  assert.equal(shouldReplaceSlotContainer({ existing: stopped, recreate: false, network: 'host', image: 'other' }), true)
})

test('missing container is not replaced', () => {
  assert.equal(shouldReplaceSlotContainer({ existing: null, recreate: true }), false)
})
