import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveForwardMode,
  applyForwardReplace,
  FORWARD_MODES,
  VM_STANDARD_REPLACE,
} from './forward-mode.mjs'

test('default forward is cli', () => {
  assert.equal(resolveForwardMode({}, {}), 'cli')
})

test('x-kin-forward selects relay / cliproxy aliases', () => {
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'sub2api' } }, {}), 'relay')
  assert.equal(resolveForwardMode({ headers: { 'x-kin-forward': 'cliproxy' } }, {}), 'cli')
})

test('cli and relay both full-replace identity (consistency)', () => {
  const body = {
    settings: { theme: 'light' },
    metadata: {
      user_id: JSON.stringify({ device_id: 'win-dev', account_uuid: 'win-acc', session_id: 'win-sess' }),
      machine_id: 'pc',
    },
  }
  const id = {
    sessionId: 'vm-sess',
    metadataUserId: JSON.stringify({ device_id: 'vm-dev', account_uuid: 'vm-acc', session_id: 'vm-sess' }),
  }
  const a = applyForwardReplace('cli', body, id)
  const b = applyForwardReplace('relay', body, id)
  const uidA = JSON.parse(a.metadata.user_id)
  const uidB = JSON.parse(b.metadata.user_id)
  assert.equal(uidA.session_id, 'vm-sess')
  assert.equal(uidA.device_id, 'vm-dev')
  assert.equal(uidA.account_uuid, 'vm-acc')
  assert.deepEqual(uidA, uidB)
  assert.equal(a.settings, undefined)
  assert.equal(a.metadata.machine_id, undefined)
})

test('applyForwardMode ignores mode for identity surface', () => {
  const body = { metadata: { user_id: 'windows' } }
  const id = { metadataUserId: '{"device_id":"d","account_uuid":"a","session_id":"s"}' }
  assert.deepEqual(
    applyForwardReplace('cli', body, id).metadata,
    applyForwardReplace('relay', body, id).metadata,
  )
})

test('replace sets match the requirement matrix (full VM standard both modes)', () => {
  assert.deepEqual([...FORWARD_MODES.cli.replace], [...VM_STANDARD_REPLACE])
  assert.deepEqual([...FORWARD_MODES.relay.replace], [...VM_STANDARD_REPLACE])
})
