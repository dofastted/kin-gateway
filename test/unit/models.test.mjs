import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  isCatalogModelId,
  latestIdForFamily,
  resolveCatalogModel,
  setModelCatalog,
  ingestWorkerModels,
  listOfficialModels,
  validateOfficialModel,
  clearModelsCache,
} from '../../src/lib/models.mjs'

test('isCatalogModelId rejects fragments', () => {
  assert.equal(isCatalogModelId('claude-sonnet-5'), true)
  assert.equal(isCatalogModelId('claude-3'), false)
  assert.equal(isCatalogModelId('claude-fable-5.md'), false)
  assert.equal(isCatalogModelId('claude-haiku-'), false)
})

test('alias resolves to latest non-fast catalog id', () => {
  const ids = ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-fast', 'claude-opus-4-8', 'claude-opus-5']
  assert.equal(latestIdForFamily('sonnet', ids), 'claude-sonnet-5')
  assert.equal(latestIdForFamily('opus', ids), 'claude-opus-5')
  assert.equal(resolveCatalogModel('sonnet', ids).model, 'claude-sonnet-5')
  assert.equal(resolveCatalogModel('opus[1m]', ids).model, 'claude-opus-5[1m]')
})

test('validateOfficialModel only accepts the loaded catalog', () => {
  setModelCatalog([
    'claude-sonnet-5',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
  ])
  assert.equal(validateOfficialModel('anthropic/claude-sonnet-5').ok, true)
  assert.equal(validateOfficialModel('anthropic/claude-sonnet-5').model, 'claude-sonnet-5')
  assert.equal(validateOfficialModel('openrouter/anthropic/claude-opus-4-6').model, 'claude-opus-4-6')
  assert.equal(validateOfficialModel('sonnet').model, 'claude-sonnet-5')
  assert.equal(validateOfficialModel('gpt-4o').ok, false)
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
  assert.equal(validateOfficialModel('claude-opus-4-1').ok, false)
  clearModelsCache()
})

test('empty catalog accepts only well-formed Claude IDs while worker catalog loads', () => {
  clearModelsCache()
  const r = resolveCatalogModel('claude-sonnet-5', [])
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'catalog_unavailable')
  assert.equal(validateOfficialModel('claude-sonnet-5').ok, true)
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
})

test('ingestWorkerModels merges worker list responses into the catalog', () => {
  clearModelsCache()
  ingestWorkerModels({ object: 'list', data: [{ id: 'claude-sonnet-5' }, { id: 'not-a-model' }] })
  ingestWorkerModels({ data: ['claude-opus-4-6'] })
  const ids = listOfficialModels().map((m) => m.id).sort()
  assert.deepEqual(ids, ['claude-opus-4-6', 'claude-sonnet-5'])
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
  clearModelsCache()
})

test('models module never talks to Anthropic or a CLI binary', () => {
  const src = fs.readFileSync(new URL('../../src/lib/models.mjs', import.meta.url), 'utf8')
  assert.equal(src.includes('api.anthropic.com'), false)
  assert.equal(src.includes('oauth-2025-04-20'), false)
  assert.equal(src.includes('spawnSync'), false)
  assert.equal(src.includes('child_process'), false)
  assert.equal(/user-agent.*claude-cli/.test(src), false)
})
